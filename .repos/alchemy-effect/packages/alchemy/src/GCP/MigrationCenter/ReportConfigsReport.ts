import * as mc from "@distilled.cloud/gcp/migrationcenter_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
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
  expandParent,
  fingerprint,
  hasOwnershipMarker,
  locationParent,
  normalizeLocation,
  ownedByAlchemy,
  parseName,
  parseOwnership,
  replaceOnIdentity,
  ResourceNotResolved,
  toPhysicalId,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
} from "./internal.ts";

export type ReportType = mc.ReportTypeEnum | (string & {});
export type ReportState = mc.ReportStateEnum | (string & {});

export type ReportConfigsReportProps = {
  /**
   * Parent report config. Full name
   * `projects/{project}/locations/{location}/reportConfigs/{reportConfig}`
   * or the report config id (combined with `location`). Immutable —
   * changing it replaces the report.
   */
  reportConfig: string;
  /**
   * Region used when `reportConfig` is a bare id.
   * @default the stack's GCP region (`GCP.Region`, else the profile
   *   region, else `us-central1`)
   */
  location?: string;
  /**
   * Report id (the `{report}` segment). If omitted, a unique RFC1035 name
   * is generated. Immutable — changing it replaces the report.
   */
  reportId?: string;
  /**
   * Report type. The API has no update method, so changing it replaces
   * the report.
   * @default "TOTAL_COST_OF_OWNERSHIP"
   */
  type?: ReportType;
  /**
   * User-friendly display name. Maximum length is 63 characters.
   */
  displayName?: string;
  /**
   * Free-text description. Reports have no labels field, so Alchemy
   * ownership is stored in a `[alchemy …]` prefix and stripped from
   * attributes.
   */
  description?: string;
};

export type ReportConfigsReport = Resource<
  "GCP.MigrationCenter.ReportConfigsReport",
  ReportConfigsReportProps,
  {
    /** Full resource name. */
    name: string;
    /** Report id (last path segment). */
    reportId: string;
    /** Parent report config resource name. */
    reportConfig: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Report type. */
    type: string | undefined;
    /** User-friendly display name. */
    displayName: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Server-reported state. */
    state: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A point-in-time Migration Center report rendered from a report config
 * (typically a total cost of ownership view).
 *
 * Reports have no labels field — Alchemy stamps ownership into the
 * description so `list` / nuke can find them. The API has no patch
 * method; changing type, display name, or description replaces the
 * report.
 *
 * ### Creating a Report
 * **Example:** TCO report
 * ```typescript
 * const report = yield* GCP.MigrationCenter.ReportConfigsReport("Tco", {
 *   reportConfig: config.name,
 *   type: "TOTAL_COST_OF_OWNERSHIP",
 *   displayName: "q1-tco",
 * });
 * ```
 *
 * @resource
 * @category MigrationCenter
 */
export const ReportConfigsReport = Resource<ReportConfigsReport>(
  "GCP.MigrationCenter.ReportConfigsReport",
);

const DEFAULT_TYPE: ReportType = "TOTAL_COST_OF_OWNERSHIP";

const configNameOf = (value: string, project: string, location: string) =>
  expandParent(value, project, location, "reportConfigs");

const resourceName = (reportConfig: string, reportId: string) =>
  `${reportConfig}/reports/${reportId}`;

const toAttrs = (item: mc.Report, project: string, region: string) => {
  const name = item.name ?? "";
  const parsed = parseName(name, "reports", region);
  const ownership = parseOwnership(item.description);
  return {
    name,
    reportId: parsed.id,
    reportConfig: parsed.parent,
    project: parsed.project || project,
    location: parsed.location,
    type: item.type,
    displayName: item.displayName,
    description: ownership.text,
    state: item.state,
    createTime: item.createTime,
    updateTime: item.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : mc
        .getProjectsLocationsReportConfigsReports({
          name,
          view: "REPORT_VIEW_BASIC",
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listReports = (parent: string) =>
  mc.listProjectsLocationsReportConfigsReports
    .pages({
      parent,
      pageSize: 1000,
      view: "REPORT_VIEW_BASIC",
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.reports ?? [])),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([] as mc.Report[])),
    );

const listConfigs = (project: string, region: string) =>
  mc.listProjectsLocationsReportConfigs
    .pages({
      parent: `projects/${project}/locations/-`,
      pageSize: 1000,
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.reportConfigs ?? [])),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () =>
        mc.listProjectsLocationsReportConfigs
          .pages({
            parent: locationParent(project, region),
            pageSize: 1000,
          })
          .pipe(
            Stream.flatMap((page) =>
              Stream.fromIterable(page.reportConfigs ?? []),
            ),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
            Effect.catchTag("NotFound", () =>
              Effect.succeed([] as mc.ReportConfig[]),
            ),
          ),
      ),
    );

const listOwned = (project: string, region: string) =>
  Effect.gen(function* () {
    const configs = yield* listConfigs(project, region);
    const reports: mc.Report[] = [];
    for (const config of configs) {
      if (config.name === undefined) continue;
      const nested = yield* listReports(config.name);
      for (const report of nested) {
        if (hasOwnershipMarker(report.description)) reports.push(report);
      }
    }
    return reports;
  });

export const ReportConfigsReportProvider = () =>
  Provider.succeed(ReportConfigsReport, {
    stables: [
      "name",
      "reportId",
      "reportConfig",
      "project",
      "location",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const payloadChanged =
        fingerprint({
          type: news.type ?? DEFAULT_TYPE,
          displayName: news.displayName,
          description: news.description,
        }) !==
        fingerprint({
          type: olds?.type ?? output?.type ?? DEFAULT_TYPE,
          displayName: olds?.displayName ?? output?.displayName,
          description: olds?.description ?? output?.description,
        });
      return replaceOnIdentity({
        previousId: olds?.reportId ?? output?.reportId,
        nextId: news.reportId ?? olds?.reportId ?? output?.reportId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
          env.region,
        ),
        previousParent: olds?.reportConfig ?? output?.reportConfig,
        nextParent: news.reportConfig,
        extra: payloadChanged,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const reportConfig = configNameOf(
        olds?.reportConfig ?? output?.reportConfig ?? "",
        env.project,
        location,
      );
      const reportId = yield* toPhysicalId(
        id,
        olds?.reportId,
        output?.reportId,
        "report",
      );
      const name =
        output?.name ??
        (reportConfig.length > 0 ? resourceName(reportConfig, reportId) : "");
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region);
      return (yield* ownedByAlchemy(id, existing.description))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* listOwned(env.project, env.region);
        return items.map((item) => toAttrs(item, env.project, env.region));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const reportConfig = configNameOf(
        news.reportConfig,
        env.project,
        location,
      );
      const reportId = yield* toPhysicalId(
        id,
        news.reportId,
        output?.reportId,
        "report",
      );
      const name = resourceName(reportConfig, reportId);
      const ownership = yield* createInternalLabels(id);
      const description = encodeOwnership(ownership, news.description);
      const displayName = news.displayName ?? reportId;
      const type = news.type ?? DEFAULT_TYPE;

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* mc
          .createProjectsLocationsReportConfigsReports({
            parent: reportConfig,
            reportId,
            body: {
              type,
              displayName,
              description,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilExists(getByName(name), name);
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({ name });
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* mc
        .deleteProjectsLocationsReportConfigsReports({ name: output.name })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
