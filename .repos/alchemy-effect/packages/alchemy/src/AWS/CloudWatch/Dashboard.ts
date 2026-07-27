import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { AWSEnvironment, type AccountID } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { createName, retryConcurrent } from "./common.ts";

export type DashboardName = string;
export type DashboardArn =
  `arn:aws:cloudwatch::${AccountID}:dashboard/${string}`;

export type DashboardPeriodOverride = "inherit" | "auto";
export type DashboardMetricRow = (string | number | boolean | null)[];

export interface DashboardMetricWidgetProperties {
  title?: string;
  region?: string;
  stat?: string;
  period?: number;
  view?: "timeSeries" | "singleValue" | "gauge" | "bar" | "pie";
  stacked?: boolean;
  metrics: DashboardMetricRow[];
  annotations?: Record<string, unknown>;
  yAxis?: Record<string, unknown>;
  legend?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface DashboardTextWidgetProperties {
  markdown: string;
  [key: string]: unknown;
}

export interface DashboardAlarmStatusWidgetProperties {
  alarms: string[];
  title?: string;
  sortBy?: string;
  states?: string[];
  [key: string]: unknown;
}

export interface DashboardLogWidgetProperties {
  query: string;
  region?: string;
  title?: string;
  view?: "table" | "timeSeries" | "bar" | "pie";
  [key: string]: unknown;
}

export interface DashboardMetricWidget {
  type: "metric";
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  properties: DashboardMetricWidgetProperties;
}

export interface DashboardTextWidget {
  type: "text";
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  properties: DashboardTextWidgetProperties;
}

export interface DashboardAlarmStatusWidget {
  type: "alarm";
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  properties: DashboardAlarmStatusWidgetProperties;
}

export interface DashboardLogWidget {
  type: "log";
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  properties: DashboardLogWidgetProperties;
}

export type DashboardWidget =
  | DashboardMetricWidget
  | DashboardTextWidget
  | DashboardAlarmStatusWidget
  | DashboardLogWidget;

export interface DashboardBody {
  start?: string;
  end?: string;
  periodOverride?: DashboardPeriodOverride;
  widgets: DashboardWidget[];
  variables?: Record<string, unknown>[];
}

export interface DashboardProps extends Omit<
  cloudwatch.PutDashboardInput,
  "DashboardName" | "DashboardBody"
> {
  /**
   * Name of the dashboard. If omitted, a unique name is generated.
   */
  name?: DashboardName;
  /**
   * Structured dashboard document. The provider serializes it to the JSON
   * string expected by the CloudWatch API.
   */
  DashboardBody: DashboardBody;
  /**
   * Optional tags to apply to the dashboard.
   *
   * CloudWatch dashboards do not currently support the generic CloudWatch
   * tagging APIs, so these values are accepted for API consistency but are not
   * persisted remotely.
   */
  tags?: Record<string, string>;
}

export interface Dashboard extends Resource<
  "AWS.CloudWatch.Dashboard",
  DashboardProps,
  {
    /** Physical name of the dashboard. */
    dashboardName: DashboardName;
    /** ARN of the dashboard. */
    dashboardArn: DashboardArn;
    /** The parsed dashboard document as last read from CloudWatch. */
    dashboardBody: DashboardBody | undefined;
    /** Tags accepted for API consistency (not persisted remotely). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Amazon CloudWatch dashboard. The `DashboardBody` is a structured,
 * typed document (metric, text, alarm-status, and log widgets) that the
 * provider serializes to the JSON string CloudWatch expects.
 * @resource
 * @section Creating Dashboards
 * @example Basic Dashboard
 * ```typescript
 * const dashboard = yield* Dashboard("OpsDashboard", {
 *   DashboardBody: {
 *     widgets: [],
 *   },
 * });
 * ```
 *
 * @example Dashboard with Metric and Text Widgets
 * ```typescript
 * const dashboard = yield* Dashboard("PaymentsDashboard", {
 *   DashboardBody: {
 *     widgets: [
 *       {
 *         type: "text",
 *         x: 0, y: 0, width: 6, height: 3,
 *         properties: { markdown: "# Payments service" },
 *       },
 *       {
 *         type: "metric",
 *         x: 0, y: 3, width: 12, height: 6,
 *         properties: {
 *           title: "Payments processed",
 *           metrics: [["MyApp/Payments", "PaymentProcessed"]],
 *           stat: "Sum",
 *           period: 60,
 *           view: "timeSeries",
 *         },
 *       },
 *     ],
 *   },
 * });
 * ```
 *
 * @section Reading Dashboards at Runtime
 * @example Read the Dashboard Body from a Function
 * ```typescript
 * // init — bind the dashboard to the function (see GetDashboard)
 * const getDashboard = yield* AWS.CloudWatch.GetDashboard(dashboard);
 *
 * // runtime
 * const result = yield* getDashboard();
 * const body = JSON.parse(result.DashboardBody ?? "{}");
 * ```
 */
export const Dashboard = Resource<Dashboard>("AWS.CloudWatch.Dashboard");

const serializeDashboardBody = (body: DashboardBody) => JSON.stringify(body);

const parseDashboardBody = (body: string | undefined) => {
  if (!body) {
    return undefined;
  }
  return JSON.parse(body) as DashboardBody;
};

export const DashboardProvider = () =>
  Provider.effect(
    Dashboard,
    Effect.gen(function* () {
      const createDashboardName = (id: string, props: { name?: string } = {}) =>
        createName(id, props.name, 255);

      const dashboardArn = (dashboardName: string) =>
        AWSEnvironment.current.pipe(
          Effect.map(
            (env) =>
              `arn:aws:cloudwatch::${env.accountId}:dashboard/${dashboardName}` as DashboardArn,
          ),
        );

      const readDashboard = Effect.fn(function* (dashboardName: string) {
        const output = yield* cloudwatch
          .getDashboard({
            DashboardName: dashboardName,
          })
          .pipe(
            Effect.catchTag("DashboardNotFoundError", () =>
              Effect.succeed(undefined),
            ),
          );

        if (!output?.DashboardName) {
          return undefined;
        }

        return {
          dashboardName: output.DashboardName,
          dashboardArn: yield* dashboardArn(output.DashboardName),
          dashboardBody: parseDashboardBody(output.DashboardBody),
          tags: {},
        };
      });

      return {
        stables: ["dashboardName", "dashboardArn"],
        diff: Effect.fn(function* ({
          id,
          olds = {},
          news = {} as DashboardProps,
        }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createDashboardName(id, olds);
          const newName = yield* createDashboardName(id, news);

          if (oldName !== newName) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const name =
            output?.dashboardName ??
            (yield* createDashboardName(id, olds ?? {}));
          return yield* readDashboard(name);
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          // Observe — pin the physical name from `output` if present so we
          // never rename an existing dashboard; otherwise derive from
          // desired props.
          const name =
            output?.dashboardName ?? (yield* createDashboardName(id, news));

          // Ensure — `putDashboard` is a pure upsert. The CloudWatch
          // dashboard API has no separate update path, so we always send
          // the full body and let the API converge.
          yield* retryConcurrent(
            cloudwatch.putDashboard({
              DashboardName: name,
              DashboardBody: serializeDashboardBody(news.DashboardBody),
            }),
          );

          yield* session.note(yield* dashboardArn(name));

          const state = yield* readDashboard(name);
          if (!state) {
            return yield* Effect.fail(
              new Error(`failed to read reconciled dashboard '${name}'`),
            );
          }

          // Dashboards do not support the generic CloudWatch tagging APIs,
          // so `tags` is always returned as an empty record.
          return {
            ...state,
            tags: {},
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          // `DeleteDashboards` is idempotent: AWS returns success (not
          // `DashboardNotFoundError`) for names that don't exist, so a
          // re-delete after a state-persistence failure is a safe no-op.
          yield* retryConcurrent(
            cloudwatch.deleteDashboards({
              DashboardNames: [output.dashboardName],
            }),
          );
        }),
        list: () =>
          Effect.gen(function* () {
            // `listDashboards` only returns entry metadata (name/arn/size),
            // not the body, so we re-read each dashboard to produce the full
            // Attributes shape `read` returns.
            const names = yield* cloudwatch.listDashboards.pages({}).pipe(
              Stream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk).flatMap((page) =>
                  (page.DashboardEntries ?? [])
                    .map((entry) => entry.DashboardName)
                    .filter((name): name is string => name != null),
                ),
              ),
            );

            const states = yield* Effect.forEach(
              names,
              (name) => readDashboard(name),
              { concurrency: 10 },
            );

            return states.filter(
              (state): state is NonNullable<typeof state> =>
                state !== undefined,
            );
          }),
      };
    }),
  );
