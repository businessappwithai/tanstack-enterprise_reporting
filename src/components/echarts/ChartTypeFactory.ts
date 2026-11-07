import type { EChartsOption } from "echarts";
import type { ChartType, EChartsConfig } from "@/types/charts";
import {
  buildFunnel,
  buildGauge,
  buildHeatmap,
  buildSankey,
  buildSunburst,
  buildTreemap,
} from "./chart-types/AdvancedCharts";
import {
  buildArea,
  buildBar,
  buildDoughnut,
  buildLine,
  buildPie,
  buildScatter,
} from "./chart-types/BasicCharts";
import { buildGeoScatter, buildMap } from "./chart-types/GeoCharts";
import { buildBoxplot, buildCandlestick, buildParallel } from "./chart-types/StatisticalCharts";
import { getLogger } from "@/lib/logging/logger";

export function buildChart(config: EChartsConfig, rows: Record<string, unknown>[]): EChartsOption {
  const builder = BUILDER_MAP[config.type];
  if (!builder) {
    getLogger("client").event("client.ui.degraded", { what: `Unknown chart type "${config.type}", falling back to bar` });
    return buildBar(config, rows);
  }
  return builder(config, rows);
}

type Builder = (config: EChartsConfig, rows: Record<string, unknown>[]) => EChartsOption;

const BUILDER_MAP: Record<ChartType, Builder> = {
  // Basic
  bar: buildBar,
  line: buildLine,
  area: buildArea,
  pie: buildPie,
  doughnut: buildDoughnut,
  scatter: buildScatter,

  // Advanced
  heatmap: buildHeatmap,
  treemap: buildTreemap,
  sunburst: buildSunburst,
  sankey: buildSankey,
  funnel: buildFunnel,
  gauge: buildGauge,

  // Geospatial
  map: buildMap,
  geoScatter: buildGeoScatter,

  // Relational (placeholder — same as treemap structure)
  graph: buildSankey,
  tree: buildTreemap,

  // Statistical
  boxplot: buildBoxplot,
  candlestick: buildCandlestick,
  parallel: buildParallel,

  // 3D placeholders (require echarts-gl extension)
  bar3d: buildBar,
  scatter3d: buildScatter,
  surface3d: buildScatter,
};
