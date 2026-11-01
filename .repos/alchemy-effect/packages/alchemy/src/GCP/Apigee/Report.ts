import * as apigee from "@distilled.cloud/gcp/apigee_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  lastSegment,
  orgParent,
  organizationFromName,
  sameJson,
  toResourceId,
} from "./names.ts";
import {
  commentsHaveOwnership,
  createInternalLabels,
  encodeComments,
  hasAlchemyLabels,
  parseComments,
} from "./ownership.ts";

const MAX_NAME_LENGTH = 64;
const DEFAULT_METRICS: apigee.GoogleCloudApigeeV1CustomReportMetric[] = [
  { name: "message_count", function: "sum" },
];

export type ReportMetric = {
  /** Metric name, for example `message_count`. */
  name: string;
  /** Aggregate function, for example `sum`. */
  function?: string;
};

export type ReportPropertyValue = {
  /** Attribute key. */
  name?: string;
  /** Attribute value. */
  value?: string;
};

export type ReportProperty = {
  /** Property name. */
  property?: string;
  /** Property values. */
  value?: ReportPropertyValue[];
};

export type ReportProps = {
  /**
   * Apigee organization id. Defaults to the current GCP project id.
   * Immutable — changing it replaces the report.
   */
  organization?: string;
  /**
   * Report id (the `{report}` segment of
   * `organizations/{org}/reports/{report}`). If omitted, a unique name
   * is generated from the stack, stage, and logical id. Immutable —
   * changing it replaces the report.
   */
  reportId?: string;
  /**
   * Display name shown in the Apigee UI.
   */
  displayName?: string;
  /**
   * Metrics to chart. Defaults to `sum(message_count)`.
   */
  metrics?: ReportMetric[];
  /**
   * Dimensions to group by, for example `["apiproxy"]`.
   */
  dimensions?: string[];
  /**
   * Filter expression.
   */
  filter?: string;
  /**
   * Aggregation time unit (`second`, `minute`, `hour`, `day`, `week`,
   * `month`).
   */
  timeUnit?: string;
  /**
   * Chart type for the UI.
   */
  chartType?: string;
  /**
   * Sort columns.
   */
  sortByCols?: string[];
  /**
   * Sort order (`asc` or `desc`).
   */
  sortOrder?: string;
  /**
   * Extra UI metadata properties.
   */
  properties?: ReportProperty[];
  /**
   * User comments. Alchemy ownership is stored as a leading
   * `[alchemy …]` comment and stripped from attributes. Reports have no
   * labels field.
   */
  comments?: string[];
  /**
   * User tags.
   */
  tags?: string[];
};

export type Report = Resource<
  "GCP.Apigee.Report",
  ReportProps,
  {
    /** Full resource name `organizations/{org}/reports/{report}`. */
    name: string;
    /** Report id (last path segment). */
    reportId: string;
    /** Apigee organization id. */
    organization: string;
    /** Display name. */
    displayName: string | undefined;
    /** Metrics. */
    metrics: ReportMetric[];
    /** Dimensions. */
    dimensions: string[];
    /** Filter expression. */
    filter: string | undefined;
    /** Aggregation time unit. */
    timeUnit: string | undefined;
    /** Chart type. */
    chartType: string | undefined;
    /** Sort columns. */
    sortByCols: string[];
    /** Sort order. */
    sortOrder: string | undefined;
    /** UI metadata properties. */
    properties: ReportProperty[];
    /** User comments with the Alchemy ownership comment stripped. */
    comments: string[];
    /** Tags. */
    tags: string[];
    /** Environment name reported by the API, if any. */
    environment: string | undefined;
    /** Creation time in milliseconds since epoch. */
    createdAt: string | undefined;
    /** Last modification time in milliseconds since epoch. */
    lastModifiedAt: string | undefined;
  },
  never,
  Providers
>;

/**
 * An Apigee custom analytics report.
 *
 * Custom reports have no labels field, so Alchemy stamps ownership into
 * a leading comments entry (`[alchemy …]`) for `list` / nuke. Name and
 * organization are identity — changing them replaces the report.
 * Metrics, dimensions, filter, chart type, and comments update in
 * place.
 *
 * ### Creating a Report
 * **Example:** Generated name, message count by proxy
 * ```typescript
 * const report = yield* GCP.Apigee.Report("Traffic", {
 *   metrics: [{ name: "message_count", function: "sum" }],
 *   dimensions: ["apiproxy"],
 * });
 * ```
 *
 * **Example:** Named report with a filter
 * ```typescript
 * const report = yield* GCP.Apigee.Report("Errors", {
 *   reportId: "app-errors",
 *   displayName: "application errors",
 *   metrics: [{ name: "error_count", function: "sum" }],
 *   dimensions: ["apiproxy"],
 *   filter: "response_status_code ge 400",
 * });
 * ```
 *
 * @resource
 * @category Apigee
 */
export const Report = Resource<Report>("GCP.Apigee.Report");

export class ReportNotResolved extends Data.TaggedError(
  "GCP.Apigee.ReportNotResolved",
)<{
  name: string;
}> {}

const resourceName = (organization: string, reportId: string) =>
  `${orgParent(organization)}/reports/${reportId}`;

const reportIdOf = (report: apigee.GoogleCloudApigeeV1CustomReport) =>
  lastSegment(report.name ?? "");

const metricsOf = (
  metrics: readonly { name?: string; function?: string }[] | undefined,
): ReportMetric[] => {
  const mapped = (metrics ?? DEFAULT_METRICS)
    .filter(
      (metric): metric is { name: string; function?: string } =>
        metric.name !== undefined && metric.name.length > 0,
    )
    .map((metric) => ({
      name: metric.name,
      function: metric.function,
    }));
  return mapped.length > 0
    ? mapped
    : [{ name: "message_count", function: "sum" }];
};

const toAttrs = (
  report: apigee.GoogleCloudApigeeV1CustomReport,
  organization: string,
) => {
  const reportId = reportIdOf(report);
  const name = report.name?.includes("/")
    ? report.name
    : resourceName(organization, reportId);
  const parsed = parseComments(report.comments);
  return {
    name,
    reportId,
    organization:
      report.organization ?? organizationFromName(name) ?? organization,
    displayName: report.displayName,
    metrics: metricsOf(report.metrics),
    dimensions: [...(report.dimensions ?? [])],
    filter: report.filter,
    timeUnit: report.timeUnit,
    chartType: report.chartType,
    sortByCols: [...(report.sortByCols ?? [])],
    sortOrder: report.sortOrder,
    properties: (report.properties ?? []).map((property) => ({
      property: property.property,
      value: property.value ? [...property.value] : undefined,
    })),
    comments: parsed.comments,
    tags: [...(report.tags ?? [])],
    environment: report.environment,
    createdAt: report.createdAt,
    lastModifiedAt: report.lastModifiedAt,
  };
};

const getByName = (name: string) =>
  apigee
    .getOrganizationsReports({ name })
    .pipe(
      Effect.catchTag(["NotFound", "ApigeeResourceNotFound"], () =>
        Effect.succeed(undefined),
      ),
    );

const toBody = (
  news: ReportProps,
  reportId: string,
  comments: string[],
): apigee.GoogleCloudApigeeV1CustomReport => ({
  name: reportId,
  displayName: news.displayName,
  metrics: metricsOf(news.metrics),
  dimensions: news.dimensions,
  filter: news.filter,
  timeUnit: news.timeUnit,
  chartType: news.chartType,
  sortByCols: news.sortByCols,
  sortOrder: news.sortOrder,
  properties: news.properties?.map((property) => ({
    property: property.property,
    value: property.value,
  })),
  comments,
  tags: news.tags,
});

export const ReportProvider = () =>
  Provider.succeed(Report, {
    stables: ["name", "reportId", "organization", "createdAt"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.reportId ?? output?.reportId;
      const previousOrg = olds?.organization ?? output?.organization;
      if (
        (previousId !== undefined &&
          news.reportId !== undefined &&
          news.reportId !== previousId) ||
        (previousOrg !== undefined &&
          news.organization !== undefined &&
          news.organization !== previousOrg)
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const organization =
        organizationFromName(output?.name) ?? olds?.organization ?? env.project;
      const reportId = yield* toResourceId(
        id,
        olds?.reportId,
        output?.reportId,
        MAX_NAME_LENGTH,
      );
      const name = output?.name ?? resourceName(organization, reportId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, organization);
      const { labels } = parseComments(existing.comments);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const page = yield* apigee
          .listOrganizationsReports({
            parent: orgParent(env.project),
            expand: true,
          })
          .pipe(
            Effect.catchTag(["NotFound", "ApigeeResourceNotFound"], () =>
              Effect.succeed({
                qualifier: [] as apigee.GoogleCloudApigeeV1CustomReport[],
              }),
            ),
          );
        return (page.qualifier ?? [])
          .filter((report) => commentsHaveOwnership(report.comments))
          .map((report) => toAttrs(report, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const organization =
        news.organization ?? output?.organization ?? env.project;
      const reportId = yield* toResourceId(
        id,
        news.reportId,
        output?.reportId,
        MAX_NAME_LENGTH,
      );
      const name = resourceName(organization, reportId);
      const ownership = yield* createInternalLabels(id);
      const desiredComments = encodeComments(ownership, news.comments);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* apigee
          .createOrganizationsReports({
            parent: orgParent(organization),
            body: toBody(news, reportId, desiredComments),
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new ReportNotResolved({ name });
      }

      const desired = toBody(news, reportId, desiredComments);
      const changed =
        (current.displayName ?? "") !== (desired.displayName ?? "") ||
        !sameJson(metricsOf(current.metrics), metricsOf(desired.metrics)) ||
        !sameJson(current.dimensions ?? [], desired.dimensions ?? []) ||
        (current.filter ?? "") !== (desired.filter ?? "") ||
        (current.timeUnit ?? "") !== (desired.timeUnit ?? "") ||
        (current.chartType ?? "") !== (desired.chartType ?? "") ||
        !sameJson(current.sortByCols ?? [], desired.sortByCols ?? []) ||
        (current.sortOrder ?? "") !== (desired.sortOrder ?? "") ||
        !sameJson(current.properties ?? [], desired.properties ?? []) ||
        !sameJson(current.comments ?? [], desiredComments) ||
        !sameJson(current.tags ?? [], desired.tags ?? []);

      if (changed) {
        current = yield* apigee.updateOrganizationsReports({
          name: current.name?.includes("/") ? current.name : name,
          body: desired,
        });
      }

      return toAttrs(current, organization);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* apigee
        .deleteOrganizationsReports({ name: output.name })
        .pipe(
          Effect.catchTag(
            ["NotFound", "ApigeeResourceNotFound"],
            () => Effect.void,
          ),
        );
    }),
  });
