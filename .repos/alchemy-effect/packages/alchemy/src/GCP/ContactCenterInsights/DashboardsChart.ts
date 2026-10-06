import * as cci from "@distilled.cloud/gcp/contactcenterinsights_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import type { DateRangeConfig } from "./Dashboard.ts";
import {
  encodeOwnership,
  hasOwnershipMarker,
  lastSegment,
  locationOf,
  locationParent,
  ownedByAlchemy,
  parentOf,
  parseOwnership,
  sameJson,
  toResourceId,
} from "./ownership.ts";

export type DashboardsChartProps = {
  /**
   * Parent Dashboard resource name
   * (`projects/{project}/locations/{location}/dashboards/{dashboard}`).
   * Immutable — changing it replaces the chart.
   */
  parent: string;
  /**
   * Chart id (the `{chart}` segment). If omitted, a unique id is generated.
   * Immutable — changing it replaces the chart. 4-64 characters matching
   * `^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$`.
   */
  chartId?: string;
  /**
   * User-facing display name.
   */
  displayName?: string;
  /**
   * Chart description. Charts have no labels field, so Alchemy ownership
   * is stored in a `[alchemy …]` prefix and stripped from attributes.
   */
  description?: string;
  /**
   * Filter applied to the chart.
   */
  filter?: string;
  /**
   * Width in grid units.
   */
  width?: number;
  /**
   * Height in grid units.
   */
  height?: number;
  /**
   * Visualization (`BAR`, `LINE`, `AREA`, `PIE`, `TABLE`, …).
   */
  chartVisualizationType?:
    | "CHART_VISUALIZATION_TYPE_UNSPECIFIED"
    | "BAR"
    | "LINE"
    | "AREA"
    | "PIE"
    | "SCATTER"
    | "TABLE"
    | "SCORE_CARD"
    | "SUNBURST"
    | "GAUGE"
    | "SANKEY";
  /**
   * Date range applied to the chart.
   */
  dateRangeConfig?: DateRangeConfig;
  /**
   * Query or generative-insights data source.
   */
  dataSource?: cci.GoogleCloudContactcenterinsightsV1ChartDataSource;
  /**
   * Click action (redirect or conversation filter).
   */
  action?: cci.GoogleCloudContactcenterinsightsV1ChartAction;
};

export type DashboardsChart = Resource<
  "GCP.ContactCenterInsights.DashboardsChart",
  DashboardsChartProps,
  {
    /** Full resource name. */
    name: string;
    /** Chart id (last path segment). */
    chartId: string;
    /** Parent dashboard resource name. */
    parent: string;
    /** Region id. */
    location: string;
    /** Project id. */
    project: string;
    /** User-facing display name. */
    displayName: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Chart filter. */
    filter: string | undefined;
    /** Width in grid units. */
    width: number | undefined;
    /** Height in grid units. */
    height: number | undefined;
    /** Server-assigned chart type. */
    chartType: string | undefined;
    /** Visualization type. */
    chartVisualizationType: string | undefined;
    /** Date range config. */
    dateRangeConfig: DateRangeConfig | undefined;
    /** Data source. */
    dataSource:
      | cci.GoogleCloudContactcenterinsightsV1ChartDataSource
      | undefined;
    /** Click action. */
    action: cci.GoogleCloudContactcenterinsightsV1ChartAction | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A chart widget on a Contact Center Insights dashboard.
 *
 * Parent dashboard and chart id are immutable. Charts have no labels
 * field — Alchemy stamps ownership into the description. Display name,
 * description, filter, size, visualization, and data source update in
 * place.
 *
 * ### Creating a Chart
 * **Example:** Bar chart on a dashboard
 * ```typescript
 * const chart = yield* GCP.ContactCenterInsights.DashboardsChart("Volume", {
 *   parent: dashboard.name,
 *   displayName: "volume",
 *   chartVisualizationType: "BAR",
 * });
 * ```
 *
 * @resource
 * @category ContactCenterInsights
 */
export const DashboardsChart = Resource<DashboardsChart>(
  "GCP.ContactCenterInsights.DashboardsChart",
);

export class DashboardsChartNotResolved extends Data.TaggedError(
  "GCP.ContactCenterInsights.DashboardsChartNotResolved",
)<{
  name: string;
}> {}

const resourceName = (parent: string, chartId: string) =>
  `${parent}/charts/${chartId}`;

const optionalString = (value: string | undefined): string | undefined => value;

const toDateRangeConfig = (
  config: cci.GoogleCloudContactcenterinsightsV1DateRangeConfig | undefined,
): DateRangeConfig | undefined => {
  if (config === undefined) return undefined;
  return {
    relativeDateRange:
      config.relativeDateRange === undefined
        ? undefined
        : {
            quantity: config.relativeDateRange.quantity,
            unit: config.relativeDateRange.unit,
          },
    absoluteDateRange:
      config.absoluteDateRange === undefined
        ? undefined
        : {
            startTime: config.absoluteDateRange.startTime,
            endTime: config.absoluteDateRange.endTime,
          },
  };
};

const toAttrs = (
  chart: cci.GoogleCloudContactcenterinsightsV1Chart,
  project: string,
) => {
  const name = chart.name ?? "";
  const parsed = parseOwnership(chart.description);
  return {
    name,
    chartId: lastSegment(name),
    parent: parentOf(name),
    location: locationOf(name),
    project,
    displayName: chart.displayName,
    description: parsed.text,
    filter: chart.filter,
    width: chart.width,
    height: chart.height,
    chartType: optionalString(chart.chartType),
    chartVisualizationType: optionalString(chart.chartVisualizationType),
    dateRangeConfig: toDateRangeConfig(chart.dateRangeConfig),
    dataSource: chart.dataSource,
    action: chart.action,
    createTime: chart.createTime,
    updateTime: chart.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : cci
        .getProjectsLocationsDashboardsCharts({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listDashboards = (parent: string) =>
  cci.listProjectsLocationsDashboards.pages({ parent, pageSize: 100 }).pipe(
    Stream.flatMap((page) => Stream.fromIterable(page.dashboards ?? [])),
    Stream.map((dashboard) => dashboard.name ?? ""),
    Stream.filter((name) => name.length > 0),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
    Effect.catchTag("NotFound", () => Effect.succeed([] as string[])),
  );

const listAtParent = (parent: string, project: string) =>
  cci.listProjectsLocationsDashboardsCharts({ parent }).pipe(
    Effect.map((page) =>
      (page.charts ?? [])
        .filter((chart) => hasOwnershipMarker(chart.description))
        .map((chart) => toAttrs(chart, project)),
    ),
    Effect.catchTag("NotFound", () => Effect.succeed([])),
  );

export const DashboardsChartProvider = () =>
  Provider.succeed(DashboardsChart, {
    stables: ["name", "chartId", "parent", "location", "project", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousParent = olds?.parent ?? output?.parent;
      if (previousParent !== undefined && news.parent !== previousParent) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousId = olds?.chartId ?? output?.chartId;
      if (
        previousId !== undefined &&
        news.chartId !== undefined &&
        news.chartId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const chartId = yield* toResourceId(id, olds?.chartId, output?.chartId);
      const name =
        output?.name ??
        (olds?.parent !== undefined ? resourceName(olds.parent, chartId) : "");
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* ownedByAlchemy(id, existing.description))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const dashboards = yield* listDashboards(
          locationParent(env.project, env.region),
        );
        const pages = yield* Effect.forEach(
          dashboards,
          (parent) => listAtParent(parent, env.project),
          { concurrency: 4 },
        );
        return pages.flat();
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const chartId = yield* toResourceId(id, news.chartId, output?.chartId);
      const name = resourceName(news.parent, chartId);
      const ownership = yield* createInternalLabels(id);
      const description = encodeOwnership(ownership, news.description);
      const displayName = news.displayName ?? chartId;

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* cci
          .createProjectsLocationsDashboardsCharts({
            parent: news.parent,
            chartId,
            body: {
              displayName,
              description,
              filter: news.filter,
              width: news.width,
              height: news.height,
              chartVisualizationType: news.chartVisualizationType,
              dateRangeConfig: news.dateRangeConfig,
              dataSource: news.dataSource,
              action: news.action,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new DashboardsChartNotResolved({ name });
      }

      const displayChanged = (current.displayName ?? "") !== displayName;
      const descriptionChanged = (current.description ?? "") !== description;
      const filterChanged = (current.filter ?? "") !== (news.filter ?? "");
      const widthChanged = (current.width ?? 0) !== (news.width ?? 0);
      const heightChanged = (current.height ?? 0) !== (news.height ?? 0);
      const vizChanged =
        (current.chartVisualizationType ?? "") !==
        (news.chartVisualizationType ?? "");
      const dateRangeChanged = !sameJson(
        current.dateRangeConfig,
        news.dateRangeConfig,
      );
      const dataSourceChanged = !sameJson(current.dataSource, news.dataSource);
      const actionChanged = !sameJson(current.action, news.action);

      if (
        displayChanged ||
        descriptionChanged ||
        filterChanged ||
        widthChanged ||
        heightChanged ||
        vizChanged ||
        dateRangeChanged ||
        dataSourceChanged ||
        actionChanged
      ) {
        current = yield* cci.patchProjectsLocationsDashboardsCharts({
          name: current.name ?? name,
          updateMask: "*",
          body: {
            name: current.name ?? name,
            displayName,
            description,
            filter: news.filter,
            width: news.width,
            height: news.height,
            chartVisualizationType: news.chartVisualizationType,
            dateRangeConfig: news.dateRangeConfig,
            dataSource: news.dataSource,
            action: news.action,
          },
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* cci
        .deleteProjectsLocationsDashboardsCharts({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
