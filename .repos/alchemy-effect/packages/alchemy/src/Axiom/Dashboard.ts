import * as Axiom from "@distilled.cloud/axiom";
import * as Effect from "effect/Effect";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import type { Chart, LayoutCell } from "./Chart.ts";
import type { Providers } from "./Providers.ts";

type DashboardDoc = Axiom.CreateDashboardInput["dashboard"];

/**
 * Dashboard input. Mirrors `Operations.CreateDashboardInput` but
 * narrows `dashboard.charts` and `dashboard.layout` to the typed
 * {@link Chart} / {@link LayoutCell} shapes (Axiom declares them
 * as `Schema.Array(Schema.Unknown)`, so this is a compile-time-only
 * refinement; runtime validation is unchanged).
 */
export type DashboardProps = Omit<Axiom.CreateDashboardInput, "dashboard"> & {
  readonly dashboard: Omit<DashboardDoc, "charts" | "layout"> & {
    readonly charts: readonly Chart[];
    readonly layout: readonly LayoutCell[];
  };
};

export type Dashboard = Resource<
  "Axiom.Dashboard",
  DashboardProps,
  {
    /** Stable Axiom dashboard `uid` (used as the path identifier). */
    uid: string;
    id: string;
    createdAt: string;
    createdBy: string;
    updatedAt: string;
    updatedBy: string;
    /** The full dashboard document as returned by Axiom. */
    dashboard: Axiom.CreateDashboardOutput["dashboard"]["dashboard"];
  },
  never,
  Providers
>;

/**
 * An Axiom dashboard — a named, layout-driven collection of charts. Each
 * dashboard takes a full document (`charts` + `layout` array of grid cells +
 * `timeWindow` + `refreshTime`) at version `schemaVersion: 2`.
 *
 * Charts are typed via {@link Chart} (a discriminated union over the
 * Axiom-validated chart kinds — `TimeSeries`, `Table`, `Pie`, `Statistic`,
 * `Heatmap`, `LogStream`, `Note`). The `id` on each chart is a free-form
 * string the author picks; layout cells join via `LayoutCell.i`.
 *
 * The path identifier is `uid` (auto-assigned by Axiom). `id` is also
 * exposed as an output but the API uses `uid` everywhere.
 *
 * Notes from probing `POST /v2/dashboards`:
 *
 * - Relative time windows must use the `qr-now-{duration}` form (e.g.
 *   `"qr-now-7d"` / `"qr-now"`); plain `"now-7d"` is rejected.
 * - When authenticating with an API token, `dashboard.owner` must be `""`
 *   (Axiom rewrites this to the org-shared `X-AXIOM-EVERYONE`); per-user
 *   "private" dashboards aren't allowed for tokens.
 * - The chart payload is strict: only `id`, `name`, `type`, `query`. Extra
 *   keys (e.g. `dataset`, `description`) trigger
 *   `Unrecognized keys: "<name>"`.
 *
 * @see https://axiom.co/docs/query-data/dashboards
 *
 * @section Creating a Dashboard
 * @example Minimal empty dashboard
 * ```typescript
 * yield* Axiom.Dashboard("ops", {
 *   dashboard: {
 *     name: "Ops Overview",
 *     owner: "",                 // org-shared (required for API tokens)
 *     description: "Top-level service health",
 *     charts: [],
 *     layout: [],
 *     refreshTime: 60,           // seconds: 15 | 60 | 300
 *     schemaVersion: 2,
 *     timeWindowStart: "qr-now-1h",
 *     timeWindowEnd: "qr-now",
 *   },
 * });
 * ```
 *
 * @example One-chart dashboard
 * ```typescript
 * import type { Chart, LayoutCell } from "alchemy/Axiom";
 *
 * const errors: Chart = {
 *   id: "errors-5m",
 *   name: "5xx errors / 5m",
 *   type: "TimeSeries",
 *   query: {
 *     apl: `['my-app-traces']
 *       | where status >= 500
 *       | summarize count() by bin_auto(_time)`,
 *   },
 * };
 *
 * yield* Axiom.Dashboard("errors", {
 *   dashboard: {
 *     name: "Errors",
 *     owner: "",
 *     refreshTime: 60,
 *     schemaVersion: 2,
 *     timeWindowStart: "qr-now-24h",
 *     timeWindowEnd: "qr-now",
 *     charts: [errors],
 *     layout: [{ i: errors.id, x: 0, y: 0, w: 12, h: 6 } satisfies LayoutCell],
 *   },
 * });
 * ```
 *
 * @example Compare to last 24h
 * ```typescript
 * yield* Axiom.Dashboard("compare", {
 *   dashboard: {
 *     name: "Compare vs yesterday",
 *     owner: "",
 *     refreshTime: 300,
 *     schemaVersion: 2,
 *     timeWindowStart: "qr-now-1h",
 *     timeWindowEnd: "qr-now",
 *     against: "-1d",            // overlay the same window from 24h ago
 *     charts: [],
 *     layout: [],
 *   },
 * });
 * ```
 */
export const Dashboard = Resource<Dashboard>("Axiom.Dashboard");

export const DashboardProvider = () =>
  Provider.effect(
    Dashboard,
    Effect.gen(function* () {
      const create = yield* Axiom.createDashboard;
      const update = yield* Axiom.updateDashboard;
      const get = yield* Axiom.getDashboard;
      const del = yield* Axiom.deleteDashboard;

      const toAttrsFromCreate = (envelope: Axiom.CreateDashboardOutput) => ({
        uid: envelope.dashboard.uid,
        id: envelope.dashboard.id,
        createdAt: envelope.dashboard.createdAt,
        createdBy: envelope.dashboard.createdBy,
        updatedAt: envelope.dashboard.updatedAt,
        updatedBy: envelope.dashboard.updatedBy,
        dashboard: envelope.dashboard.dashboard,
      });
      const toAttrsFromGet = (current: Axiom.GetDashboardOutput) => ({
        uid: current.uid,
        id: current.id,
        createdAt: current.createdAt,
        createdBy: current.createdBy,
        updatedAt: current.updatedAt,
        updatedBy: current.updatedBy,
        dashboard: current.dashboard,
      });

      return {
        stables: ["uid", "id", "createdAt", "createdBy"],
        reconcile: Effect.fn(function* ({ news, output }) {
          // Observe — `uid` is server-assigned at create time. We probe
          // Axiom for the dashboard via the cached uid; treat NotFound
          // (deleted out-of-band) as "no observed state" so we converge
          // by re-creating.
          const observed = output?.uid
            ? yield* get({ uid: output.uid }).pipe(
                Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
              )
            : undefined;

          // Ensure — POST mints a new dashboard with a fresh uid.
          if (observed === undefined) {
            return toAttrsFromCreate(yield* create(news));
          }

          // Sync — `overwrite: true` short-circuits Axiom's optimistic-
          // concurrency check (otherwise the API requires the caller to
          // echo back the server-side `version`, which we don't track).
          return toAttrsFromCreate(
            yield* update({ ...news, uid: observed.uid, overwrite: true }),
          );
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* del({ uid: output.uid }).pipe(
            Effect.catchTag("NotFound", () => Effect.void),
          );
        }),
        read: Effect.fn(function* ({ output }) {
          if (!output?.uid) return undefined;
          return yield* get({ uid: output.uid }).pipe(
            Effect.map(toAttrsFromGet),
            Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          );
        }),
      };
    }),
  );
