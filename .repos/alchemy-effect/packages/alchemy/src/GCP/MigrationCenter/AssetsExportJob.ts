import * as mc from "@distilled.cloud/gcp/migrationcenter_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels, hasAlchemyLabels, toLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  fingerprint,
  hasAlchemyLabelMap,
  locationParent,
  normalizeLocation,
  parseName,
  replaceOnIdentity,
  ResourceNotResolved,
  toPhysicalId,
  userLabels,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
} from "./internal.ts";

export type AssetsExportJobFileFormat =
  | mc.SignedUriDestinationFileFormatEnum
  | (string & {});

export type AssetsExportJobProps = {
  /**
   * Assets export job id (the `{assetsExportJob}` segment of
   * `projects/{project}/locations/{location}/assetsExportJobs/{assetsExportJob}`).
   * If omitted, a unique RFC1035 name is generated. Immutable — changing
   * it replaces the job.
   */
  assetsExportJobId?: string;
  /**
   * Region (`us-central1`, …). Immutable — changing it replaces the job.
   * `US-CENTRAL1` is accepted and normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile
   *   region, else `us-central1`)
   */
  location?: string;
  /**
   * File format for signed-URI downloads. The API has no update method,
   * so changing it replaces the job.
   * @default "CSV"
   */
  fileFormat?: AssetsExportJobFileFormat;
  /**
   * Optional filter selecting which assets to export.
   */
  filter?: string;
  /**
   * When true, hidden assets are included in the export.
   * @default false
   */
  showHidden?: boolean;
  /**
   * When true, export asset inventory details.
   * @default true
   */
  inventory?: boolean;
  /**
   * When true, export network-dependency data.
   * @default false
   */
  networkDependencies?: boolean;
  /**
   * Performance-data window in days (1-420). Omit to skip performance
   * export.
   */
  performanceDataMaxDays?: number;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   * The API has no update method, so changing labels replaces the job.
   */
  labels?: Record<string, string>;
};

export type AssetsExportJob = Resource<
  "GCP.MigrationCenter.AssetsExportJob",
  AssetsExportJobProps,
  {
    /** Full resource name. */
    name: string;
    /** Assets export job id (last path segment). */
    assetsExportJobId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Signed-URI destination file format. */
    fileFormat: string | undefined;
    /** Asset filter. */
    filter: string | undefined;
    /** Whether hidden assets are included. */
    showHidden: boolean | undefined;
    /** Whether inventory details are exported. */
    inventory: boolean;
    /** Whether network-dependency data is exported. */
    networkDependencies: boolean;
    /** Performance-data window in days. */
    performanceDataMaxDays: number | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Migration Center assets export job that writes inventory (and
 * optional performance / network-dependency) data to signed-URI files.
 *
 * The API has no patch method — changing format, filter, inventory flags,
 * or labels replaces the job. Id and location are also immutable.
 *
 * ### Creating an Assets Export Job
 * **Example:** CSV inventory export
 * ```typescript
 * const job = yield* GCP.MigrationCenter.AssetsExportJob("Inventory", {
 *   fileFormat: "CSV",
 *   labels: { env: "test" },
 * });
 * ```
 *
 * **Example:** XLSX with performance data
 * ```typescript
 * const job = yield* GCP.MigrationCenter.AssetsExportJob("Inventory", {
 *   fileFormat: "XLSX",
 *   performanceDataMaxDays: 40,
 * });
 * ```
 *
 * @resource
 * @category MigrationCenter
 */
export const AssetsExportJob = Resource<AssetsExportJob>(
  "GCP.MigrationCenter.AssetsExportJob",
);

const DEFAULT_FORMAT: AssetsExportJobFileFormat = "CSV";

const resourceName = (
  project: string,
  location: string,
  assetsExportJobId: string,
) =>
  `${locationParent(project, location)}/assetsExportJobs/${assetsExportJobId}`;

const toAttrs = (job: mc.AssetsExportJob, project: string, region: string) => {
  const name = job.name ?? "";
  const parsed = parseName(name, "assetsExportJobs", region);
  return {
    name,
    assetsExportJobId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    fileFormat: job.signedUriDestination?.fileFormat,
    filter: job.condition?.filter,
    showHidden: job.showHidden,
    inventory: job.inventory !== undefined,
    networkDependencies: job.networkDependencies !== undefined,
    performanceDataMaxDays: job.performanceData?.maxDays,
    labels: userLabels(job.labels),
    createTime: job.createTime,
    updateTime: job.updateTime,
  };
};

const desiredBody = (
  news: AssetsExportJobProps,
  labels: Record<string, string>,
): mc.AssetsExportJob => ({
  labels,
  showHidden: news.showHidden === true,
  condition:
    news.filter !== undefined && news.filter.length > 0
      ? { filter: news.filter }
      : undefined,
  signedUriDestination: {
    fileFormat: news.fileFormat ?? DEFAULT_FORMAT,
  },
  inventory: news.inventory === false ? undefined : {},
  networkDependencies: news.networkDependencies === true ? {} : undefined,
  performanceData:
    news.performanceDataMaxDays !== undefined
      ? { maxDays: news.performanceDataMaxDays }
      : undefined,
});

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : mc
        .getProjectsLocationsAssetsExportJobs({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string, region: string) =>
  mc.listProjectsLocationsAssetsExportJobs
    .pages({
      parent: `projects/${project}/locations/-`,
      pageSize: 1000,
    })
    .pipe(
      Stream.flatMap((page) =>
        Stream.fromIterable(page.assetsExportJobs ?? []),
      ),
      Stream.filter((item) => hasAlchemyLabelMap(item.labels)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () =>
        mc.listProjectsLocationsAssetsExportJobs
          .pages({
            parent: locationParent(project, region),
            pageSize: 1000,
          })
          .pipe(
            Stream.flatMap((page) =>
              Stream.fromIterable(page.assetsExportJobs ?? []),
            ),
            Stream.filter((item) => hasAlchemyLabelMap(item.labels)),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
            Effect.catchTag("NotFound", () =>
              Effect.succeed([] as mc.AssetsExportJob[]),
            ),
          ),
      ),
    );

export const AssetsExportJobProvider = () =>
  Provider.succeed(AssetsExportJob, {
    stables: ["name", "assetsExportJobId", "project", "location", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const payloadChanged =
        fingerprint({
          fileFormat: news.fileFormat ?? DEFAULT_FORMAT,
          filter: news.filter,
          showHidden: news.showHidden === true,
          inventory: news.inventory !== false,
          networkDependencies: news.networkDependencies === true,
          performanceDataMaxDays: news.performanceDataMaxDays,
          labels: news.labels ?? {},
        }) !==
        fingerprint({
          fileFormat: olds?.fileFormat ?? output?.fileFormat ?? DEFAULT_FORMAT,
          filter: olds?.filter ?? output?.filter,
          showHidden: (olds?.showHidden ?? output?.showHidden) === true,
          inventory: (olds?.inventory ?? output?.inventory) !== false,
          networkDependencies:
            (olds?.networkDependencies ?? output?.networkDependencies) === true,
          performanceDataMaxDays:
            olds?.performanceDataMaxDays ?? output?.performanceDataMaxDays,
          labels: olds?.labels ?? {},
        });
      return replaceOnIdentity({
        previousId: olds?.assetsExportJobId ?? output?.assetsExportJobId,
        nextId:
          news.assetsExportJobId ??
          olds?.assetsExportJobId ??
          output?.assetsExportJobId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
          env.region,
        ),
        extra: payloadChanged,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const assetsExportJobId = yield* toPhysicalId(
        id,
        olds?.assetsExportJobId,
        output?.assetsExportJobId,
        "exportjob",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, assetsExportJobId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
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
      const assetsExportJobId = yield* toPhysicalId(
        id,
        news.assetsExportJobId,
        output?.assetsExportJobId,
        "exportjob",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(env.project, location, assetsExportJobId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* mc
          .createProjectsLocationsAssetsExportJobs({
            parent: locationParent(env.project, location),
            assetsExportJobId,
            body: desiredBody(news, desiredLabels),
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
        .deleteProjectsLocationsAssetsExportJobs({ name: output.name })
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
