/**
 * Typed view of the Axiom dashboard chart-JSON subset.
 *
 * Axiom's `CreateDashboardInput` declares
 * `dashboard.charts: ReadonlyArray<unknown>` (see
 * `@distilled.cloud/axiom/.../v2/createDashboard.ts`); these
 * interfaces give callers compile-time safety when building the
 * payload by hand.
 *
 * `chart.id` is a free-form string the author picks — Axiom
 * doesn't validate the format. It joins to the matching
 * `LayoutCell.i` in `dashboard.layout`.
 */

/**
 * Axiom-validated chart kinds. Discovered by probing
 * `POST /v2/dashboards`: anything else returns
 * `dashboard validation failed at [charts N type]: Invalid input`.
 */
export type ChartKind =
  | "TimeSeries"
  | "Table"
  | "Pie"
  | "Statistic"
  | "Heatmap"
  | "LogStream"
  | "Note"
  | "SmartFilter";

/**
 * Minimum chart payload Axiom's `POST /v2/dashboards` accepts.
 * Any unknown keys (e.g. `dataset`, `description`) trigger
 * `Unrecognized keys: "<name>"`, so this struct is intentionally
 * narrow. The dataset is implicit via the APL query.
 */
export interface BaseChart {
  readonly id: string;
  readonly name: string;
  readonly type: ChartKind;
  readonly query: { readonly apl: string };
}

export interface TimeSeriesChart extends BaseChart {
  readonly type: "TimeSeries";
}

export interface TableChart extends BaseChart {
  readonly type: "Table";
}

export interface PieChart extends BaseChart {
  readonly type: "Pie";
}

export interface StatisticChart extends BaseChart {
  readonly type: "Statistic";
}

export interface HeatmapChart extends BaseChart {
  readonly type: "Heatmap";
}

export interface LogStreamChart extends BaseChart {
  readonly type: "LogStream";
}

/**
 * A free-form markdown note. Unlike data charts, `Note` has no `query`
 * or `name` — Axiom's payload is strictly `{ id, type, text, variant? }`.
 */
export interface NoteChart {
  readonly id: string;
  readonly type: "Note";
  /** Markdown body rendered in the note cell. */
  readonly text: string;
  readonly variant?: "default";
}

/**
 * A dashboard filter bar (Axiom calls it `SmartFilter` on the wire,
 * `Filter bar` in the UI). Holds one or more filters whose IDs can
 * be referenced from other charts' APL via
 * `declare query_parameters (<filter-id>:string = "")`.
 *
 * Unlike data charts, `SmartFilter` has no top-level `query` field —
 * each filter inside `filters` may carry its own option-source APL.
 */
export interface SmartFilterChart {
  readonly id: string;
  readonly type: "SmartFilter";
  /** Optional display name for the filter bar element. */
  readonly name?: string;
  readonly filters: readonly SmartFilter[];
}

/**
 * One filter inside a {@link SmartFilterChart}. Either a free-text
 * `search` filter or a dropdown `select` filter. Select filters draw
 * their options from either an inline `list` or an APL `query`.
 */
export type SmartFilter = SmartFilterSearch | SmartFilterSelect;

export interface SmartFilterSearch {
  readonly id: string;
  readonly type: "search";
  readonly name?: string;
  readonly active?: boolean;
}

export interface SmartFilterSelect {
  readonly id: string;
  readonly type: "select";
  readonly name?: string;
  readonly active?: boolean;
  /** `"list"` for inline `options`, `"apl"` for a query-driven dropdown. */
  readonly selectType?: "list" | "apl";
  /**
   * APL query that returns rows shaped `{ key, value }`. Axiom shows
   * `key` in the dropdown and substitutes `value` into chart queries.
   */
  readonly apl?: { readonly apl: string };
  /** Inline key/value options when `selectType === "list"`. */
  readonly options?: readonly {
    readonly id?: string;
    readonly key: string;
    readonly value: string;
    readonly default?: boolean;
  }[];
}

export type Chart =
  | TimeSeriesChart
  | TableChart
  | PieChart
  | StatisticChart
  | HeatmapChart
  | LogStreamChart
  | NoteChart
  | SmartFilterChart;

/**
 * Mirrors Axiom's `CreateDashboardInput.dashboard.layout` cell schema.
 * `i` references a chart by its `id`.
 */
export interface LayoutCell {
  readonly i: string;
  readonly x: number;
  readonly y: number | null;
  readonly w: number;
  readonly h: number;
  readonly minW?: number;
  readonly minH?: number;
  readonly maxW?: number;
  readonly maxH?: number;
  readonly static?: boolean;
}
