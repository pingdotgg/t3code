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
import {
  encodeOwnership,
  hasOwnershipMarker,
  lastSegment,
  locationOf,
  locationParent,
  ownedByAlchemy,
  parseOwnership,
  sameJson,
  toResourceId,
} from "./ownership.ts";

export type DateRangeConfig = {
  /** Rolling window measured in `unit`. */
  relativeDateRange?: {
    /** Number of units in the past. */
    quantity?: string;
    /** Calendar unit (`DAY`, `WEEK`, `MONTH`, `QUARTER`, `YEAR`). */
    unit?:
      | "TIME_UNIT_UNSPECIFIED"
      | "DAY"
      | "WEEK"
      | "MONTH"
      | "QUARTER"
      | "YEAR"
      | (string & {});
  };
  /** Inclusive start/end timestamps. */
  absoluteDateRange?: {
    startTime?: string;
    endTime?: string;
  };
};

export type DashboardProps = {
  /**
   * Region (`us-central1`, …). Immutable — changing it replaces the
   * dashboard.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Dashboard id (the `{dashboard}` segment). If omitted, a unique id is
   * generated from the stack, stage, and logical id. Immutable — changing
   * it replaces the dashboard. 4-64 characters matching
   * `^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$`.
   */
  dashboardId?: string;
  /**
   * User-facing display name.
   */
  displayName?: string;
  /**
   * Human-readable description. Dashboards have no labels field, so
   * Alchemy ownership is stored in a `[alchemy …]` prefix and stripped
   * from attributes.
   */
  description?: string;
  /**
   * Filter applied to every chart on the dashboard.
   */
  filter?: string;
  /**
   * Date range applied to every chart on the dashboard.
   */
  dateRangeConfig?: DateRangeConfig;
  /**
   * Root widget container describing the dashboard layout.
   */
  rootContainer?: cci.GoogleCloudContactcenterinsightsV1Container;
};

export type Dashboard = Resource<
  "GCP.ContactCenterInsights.Dashboard",
  DashboardProps,
  {
    /** Full resource name. */
    name: string;
    /** Dashboard id (last path segment). */
    dashboardId: string;
    /** Region id. */
    location: string;
    /** Project id. */
    project: string;
    /** User-facing display name. */
    displayName: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Dashboard-wide filter. */
    filter: string | undefined;
    /** Dashboard-wide date range. */
    dateRangeConfig: DateRangeConfig | undefined;
    /** Root layout container. */
    rootContainer: cci.GoogleCloudContactcenterinsightsV1Container | undefined;
    /** Whether the dashboard is a predefined read-only dashboard. */
    readOnly: boolean;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Contact Center Insights dashboard of conversation charts.
 *
 * Dashboards have no labels field — Alchemy stamps ownership into the
 * description. Location and dashboard id are immutable. Display name,
 * description, filter, date range, and root container update in place.
 *
 * ### Creating a Dashboard
 * **Example:** Generated id
 * ```typescript
 * const dashboard = yield* GCP.ContactCenterInsights.Dashboard("Overview", {
 *   displayName: "overview",
 *   description: "call quality",
 * });
 * ```
 *
 * **Example:** Named dashboard
 * ```typescript
 * const dashboard = yield* GCP.ContactCenterInsights.Dashboard("Overview", {
 *   dashboardId: "quality-overview",
 *   displayName: "quality",
 * });
 * ```
 *
 * @resource
 * @category ContactCenterInsights
 */
export const Dashboard = Resource<Dashboard>(
  "GCP.ContactCenterInsights.Dashboard",
);

export class DashboardNotResolved extends Data.TaggedError(
  "GCP.ContactCenterInsights.DashboardNotResolved",
)<{
  name: string;
}> {}

const resourceName = (parent: string, dashboardId: string) =>
  `${parent}/dashboards/${dashboardId}`;

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
  dashboard: cci.GoogleCloudContactcenterinsightsV1Dashboard,
  project: string,
) => {
  const name = dashboard.name ?? "";
  const parsed = parseOwnership(dashboard.description);
  return {
    name,
    dashboardId: lastSegment(name),
    location: locationOf(name),
    project,
    displayName: dashboard.displayName,
    description: parsed.text,
    filter: dashboard.filter,
    dateRangeConfig: toDateRangeConfig(dashboard.dateRangeConfig),
    rootContainer: dashboard.rootContainer,
    readOnly: dashboard.readOnly === true,
    createTime: dashboard.createTime,
    updateTime: dashboard.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : cci
        .getProjectsLocationsDashboards({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAt = (parent: string, project: string) =>
  cci.listProjectsLocationsDashboards.pages({ parent, pageSize: 100 }).pipe(
    Stream.flatMap((page) => Stream.fromIterable(page.dashboards ?? [])),
    Stream.filter((dashboard) => hasOwnershipMarker(dashboard.description)),
    Stream.map((dashboard) => toAttrs(dashboard, project)),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
    Effect.catchTag("NotFound", () => Effect.succeed([])),
  );

export const DashboardProvider = () =>
  Provider.succeed(Dashboard, {
    stables: ["name", "dashboardId", "location", "project", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousLocation = olds?.location ?? output?.location;
      const nextLocation = news.location;
      if (
        previousLocation !== undefined &&
        nextLocation !== undefined &&
        previousLocation !== nextLocation
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousId = olds?.dashboardId ?? output?.dashboardId;
      if (
        previousId !== undefined &&
        news.dashboardId !== undefined &&
        news.dashboardId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const dashboardId = yield* toResourceId(
        id,
        olds?.dashboardId,
        output?.dashboardId,
      );
      const location = olds?.location ?? output?.location ?? env.region;
      const name =
        output?.name ??
        resourceName(locationParent(env.project, location), dashboardId);
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
        return yield* listAt(
          locationParent(env.project, env.region),
          env.project,
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = news.location ?? output?.location ?? env.region;
      const parent = locationParent(env.project, location);
      const dashboardId = yield* toResourceId(
        id,
        news.dashboardId,
        output?.dashboardId,
      );
      const name = resourceName(parent, dashboardId);
      const ownership = yield* createInternalLabels(id);
      const description = encodeOwnership(ownership, news.description);
      const displayName = news.displayName ?? dashboardId;

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* cci
          .createProjectsLocationsDashboards({
            parent,
            dashboardId,
            body: {
              displayName,
              description,
              filter: news.filter,
              dateRangeConfig: news.dateRangeConfig,
              rootContainer: news.rootContainer,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new DashboardNotResolved({ name });
      }

      const displayChanged = (current.displayName ?? "") !== displayName;
      const descriptionChanged = (current.description ?? "") !== description;
      const filterChanged = (current.filter ?? "") !== (news.filter ?? "");
      const dateRangeChanged = !sameJson(
        current.dateRangeConfig,
        news.dateRangeConfig,
      );
      const rootChanged = !sameJson(current.rootContainer, news.rootContainer);

      if (
        displayChanged ||
        descriptionChanged ||
        filterChanged ||
        dateRangeChanged ||
        rootChanged
      ) {
        current = yield* cci.patchProjectsLocationsDashboards({
          name: current.name ?? name,
          updateMask: [
            displayChanged ? "display_name" : undefined,
            descriptionChanged ? "description" : undefined,
            filterChanged ? "filter" : undefined,
            dateRangeChanged ? "date_range_config" : undefined,
            rootChanged ? "root_container" : undefined,
          ]
            .filter((field): field is string => field !== undefined)
            .join(","),
          body: {
            name: current.name ?? name,
            displayName,
            description,
            filter: news.filter,
            dateRangeConfig: news.dateRangeConfig,
            rootContainer: news.rootContainer,
          },
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* cci
        .deleteProjectsLocationsDashboards({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
