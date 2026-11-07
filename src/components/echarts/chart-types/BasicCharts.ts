import type { EChartsOption } from "echarts";
import type { EChartsConfig } from "@/types/charts";
import {
  extractCategories,
  extractGroupedSeries,
  extractPieData,
  extractScatterData,
  extractSeries,
} from "../DataAdapter";

export function buildBar(config: EChartsConfig, rows: Record<string, unknown>[]): EChartsOption {
  const categories = extractCategories(rows, config.dataMapping);
  const series = config.dataMapping.group
    ? extractGroupedSeries(rows, config.dataMapping)
    : extractSeries(rows, config.dataMapping);

  const seriesWithStack = series.map((s, index) => {
    const baseSeries = {
      name: s.name,
      type: "bar" as const,
      data: s.data,
      ...(config.stacked === true && { stack: "stack-1" }),
    };

    if (config.seriesColors?.[index]) {
      return {
        ...baseSeries,
        itemStyle: {
          color: config.seriesColors[index],
        },
      };
    }

    return baseSeries;
  });


  const result: EChartsOption = {
    xAxis: {
      type: "category",
      data: categories,
      axisLabel: { interval: 0, rotate: 30 },
      ...config.xAxis,
    },
    yAxis: {
      type: "value",
      ...config.yAxis,
    },
    series: seriesWithStack.map((s) => ({
      ...s,
      barGap: "0%",
      barCategoryGap: "20%",
    })),
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "shadow" },
    },
    legend:
      series.length > 1
        ? {
            data: series.map((s) => s.name),
            orient: "horizontal",
            top: "bottom",
            left: "center",
            itemGap: 20,
            padding: [20, 0, 0, 0],
          }
        : undefined,
    grid: {
      left: "3%",
      right: "4%",
      bottom: "15%",
      containLabel: true,
    },
  };


  return result;
}

export function buildLine(config: EChartsConfig, rows: Record<string, unknown>[]): EChartsOption {
  const categories = extractCategories(rows, config.dataMapping);
  const series = config.dataMapping.group
    ? extractGroupedSeries(rows, config.dataMapping)
    : extractSeries(rows, config.dataMapping);

  const option: EChartsOption = {
    xAxis: { type: "category", data: categories, ...config.xAxis },
    yAxis: { type: "value", ...config.yAxis },
    series: series.map((s, index) => {
      const baseSeries = {
        name: s.name,
        type: "line" as const,
        data: s.data,
        smooth: true,
      };

      if (config.seriesColors?.[index]) {
        return {
          ...baseSeries,
          itemStyle: {
            color: config.seriesColors[index],
          },
        };
      }

      return baseSeries;
    }),
    tooltip: { trigger: "axis" },
    legend: series.length > 1 ? { data: series.map((s) => s.name) } : undefined,
  };

  return option;
}

export function buildArea(config: EChartsConfig, rows: Record<string, unknown>[]): EChartsOption {
  const categories = extractCategories(rows, config.dataMapping);
  const series = config.dataMapping.group
    ? extractGroupedSeries(rows, config.dataMapping)
    : extractSeries(rows, config.dataMapping);

  const option: EChartsOption = {
    xAxis: { type: "category", data: categories, ...config.xAxis },
    yAxis: { type: "value", ...config.yAxis },
    series: series.map((s, index) => {
      const baseSeries = {
        name: s.name,
        type: "line" as const,
        data: s.data,
        smooth: true,
        areaStyle: {},
      };

      if (config.seriesColors?.[index]) {
        return {
          ...baseSeries,
          itemStyle: {
            color: config.seriesColors[index],
          },
          areaStyle: {
            color: config.seriesColors[index],
          },
        };
      }

      return baseSeries;
    }),
    tooltip: { trigger: "axis" },
    legend: series.length > 1 ? { data: series.map((s) => s.name) } : undefined,
  };

  return option;
}

export function buildPie(config: EChartsConfig, rows: Record<string, unknown>[]): EChartsOption {
  const data = extractPieData(rows, config.dataMapping);

  return {
    series: [
      {
        type: "pie" as const,
        data,
        radius: "60%",
        emphasis: {
          itemStyle: { shadowBlur: 10, shadowOffsetX: 0, shadowColor: "rgba(0,0,0,0.5)" },
        },
      },
    ],
    tooltip: { trigger: "item" },
    legend: { orient: "vertical" as const, left: "left" },
  };
}

export function buildDoughnut(
  config: EChartsConfig,
  rows: Record<string, unknown>[]
): EChartsOption {
  const data = extractPieData(rows, config.dataMapping);

  return {
    series: [
      {
        type: "pie" as const,
        data,
        radius: ["40%", "70%"],
        emphasis: {
          itemStyle: { shadowBlur: 10, shadowOffsetX: 0, shadowColor: "rgba(0,0,0,0.5)" },
        },
      },
    ],
    tooltip: { trigger: "item" },
    legend: { orient: "vertical" as const, left: "left" },
  };
}

export function buildScatter(
  config: EChartsConfig,
  rows: Record<string, unknown>[]
): EChartsOption {
  const data = extractScatterData(rows, config.dataMapping);

  return {
    xAxis: { type: "value", ...config.xAxis },
    yAxis: { type: "value", ...config.yAxis },
    series: [
      {
        type: "scatter" as const,
        data,
        symbolSize: 8,
      },
    ],
    tooltip: { trigger: "item" },
  };
}
