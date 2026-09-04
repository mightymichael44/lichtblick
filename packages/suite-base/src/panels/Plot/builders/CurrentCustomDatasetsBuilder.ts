// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import * as _ from "lodash-es";

import { filterMap } from "@lichtblick/den/collection";
import { MessagePath } from "@lichtblick/message-path";
import { Immutable } from "@lichtblick/suite";
import { simpleGetMessagePathDataItems } from "@lichtblick/suite-base/components/MessagePathSyntax/simpleGetMessagePathDataItems";
import { mathFunctions } from "@lichtblick/suite-base/panels/Plot/utils/mathFunctions";
import { PlayerState } from "@lichtblick/suite-base/players/types";

import {
  CsvDataset,
  GetViewportDatasetsResult,
  HandlePlayerStateResult,
  IDatasetsBuilder,
  SeriesConfigKey,
  SeriesItem,
} from "./IDatasetsBuilder";
import { CurrentFrameSeriesItem } from "./types";
import { buildViewportDatasets, lastMatchingTopic, setSeries } from "./utils";
import { getChartValue, isChartValue, resolveChartDatum } from "../utils/datum";

/**
 * CurrentCustomDatasetsBuilder builds datasets from a custom x-axis message path and
 * y-axis message path. It uses only the latest message for each path to build the datasets.
 */
export class CurrentCustomDatasetsBuilder implements IDatasetsBuilder {
  #xParsedPath?: Immutable<MessagePath>;
  #xParsedPathBySeries = new Map<SeriesConfigKey, Immutable<MessagePath> | undefined>();

  #seriesByKey = new Map<SeriesConfigKey, CurrentFrameSeriesItem>();
  #pathsWithMismatchedDataLengths = new Set<string>();

  // Process the latest messages from the player state to extract any updated x or y values
  //
  // Datasets are built when y-values arrive though this could be expanded to also build
  // when x-values arrive.
  public handlePlayerState(state: Immutable<PlayerState>): HandlePlayerStateResult | undefined {
    const activeData = state.activeData;
    const hasAnyXPath =
      this.#xParsedPath != undefined ||
      [...this.#xParsedPathBySeries.values()].some((path) => path != undefined);
    if (!activeData || !hasAnyXPath) {
      return;
    }

    const msgEvents = activeData.messages;
    if (msgEvents.length === 0) {
      return;
    }

    let datasetsChanged = false;

    for (const [seriesKey, series] of this.#seriesByKey.entries()) {
      const xParsedPath = this.#xParsedPathBySeries.get(seriesKey) ?? this.#xParsedPath;
      if (!xParsedPath) {
        continue;
      }

      const xAxisMathFn =
        (xParsedPath.modifier ? mathFunctions[xParsedPath.modifier] : undefined) ??
        _.identity<number>;
      const xMsgEvent = lastMatchingTopic(msgEvents, xParsedPath.topicName);
      const xValues: number[] = [];
      if (xMsgEvent) {
        const items = simpleGetMessagePathDataItems(xMsgEvent, xParsedPath);
        datasetsChanged ||= items.length > 0;
        for (const item of items) {
          if (!isChartValue(item)) {
            continue;
          }

          const chartValue = getChartValue(item);
          if (chartValue == undefined) {
            continue;
          }

          xValues.push(xAxisMathFn(chartValue));
        }
      }

      const mathFn = series.parsed.modifier ? mathFunctions[series.parsed.modifier] : undefined;
      const yMsgEvent = lastMatchingTopic(msgEvents, series.parsed.topicName);
      if (!yMsgEvent) {
        continue;
      }

      const items = simpleGetMessagePathDataItems(yMsgEvent, series.parsed);
      datasetsChanged ||= items.length > 0;

      const pathItems = filterMap(items, (item, idx) => {
        const datum = resolveChartDatum(item, mathFn);
        if (!datum) {
          return;
        }

        return {
          x: xValues[idx] ?? NaN,
          y: datum.y,
          receiveTime: yMsgEvent.receiveTime,
          value: datum.value,
        };
      });

      if (pathItems.length === xValues.length) {
        this.#pathsWithMismatchedDataLengths.delete(series.messagePath);
      } else {
        this.#pathsWithMismatchedDataLengths.add(series.messagePath);
      }

      series.dataset.data = pathItems;
    }

    return {
      range: undefined,
      datasetsChanged,
    };
  }

  public setXPath(path: Immutable<MessagePath> | undefined): void {
    if (JSON.stringify(path) === JSON.stringify(this.#xParsedPath)) {
      return;
    }

    // When the x-path changes we clear any existing data from the datasets
    this.#xParsedPath = path;
    for (const [key, override] of this.#xParsedPathBySeries.entries()) {
      if (override == undefined) {
        this.#xParsedPathBySeries.set(key, path);
      }
    }
    for (const series of this.#seriesByKey.values()) {
      series.dataset.data = [];
    }
    this.#pathsWithMismatchedDataLengths.clear();
  }

  public setSeries(series: Immutable<SeriesItem[]>): void {
    this.#xParsedPathBySeries = new Map();
    for (const item of series) {
      this.#xParsedPathBySeries.set(item.key, item.xAxisPath ?? undefined);
    }
    this.#seriesByKey = setSeries(this.#seriesByKey, series);
  }

  // We don't use the viewport because we do not do any downsampling on the assumption that
  // one message won't produce so many points that we need to downsample.
  //
  // If that assumption changes then downsampling can be revisited.
  public async getViewportDatasets(): Promise<GetViewportDatasetsResult> {
    return buildViewportDatasets(this.#seriesByKey, this.#pathsWithMismatchedDataLengths);
  }

  public async getCsvData(): Promise<CsvDataset[]> {
    const datasets: CsvDataset[] = [];
    for (const series of this.#seriesByKey.values()) {
      if (!series.enabled) {
        continue;
      }

      datasets.push({
        label: series.messagePath,
        data: series.dataset.data,
      });
    }

    return datasets;
  }
}
