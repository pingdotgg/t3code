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
import {
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  expandParent,
  fieldMask,
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

export type ImportJobState = mc.ImportJobStateEnum | (string & {});

export type ImportJobProps = {
  /**
   * Import job id (the `{importJob}` segment of
   * `projects/{project}/locations/{location}/importJobs/{importJob}`). If
   * omitted, a unique RFC1035 name is generated. Immutable — changing it
   * replaces the job.
   */
  importJobId?: string;
  /**
   * Region (`us-central1`, …). Immutable — changing it replaces the job.
   * `US-CENTRAL1` is accepted and normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile
   *   region, else `us-central1`)
   */
  location?: string;
  /**
   * Source that receives imported frames. Full name or source id
   * (combined with `location`). Immutable — changing it replaces the job.
   */
  assetSource: string;
  /**
   * User-friendly display name. Maximum length is 256 characters.
   */
  displayName?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type ImportJob = Resource<
  "GCP.MigrationCenter.ImportJob",
  ImportJobProps,
  {
    /** Full resource name. */
    name: string;
    /** Import job id (last path segment). */
    importJobId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Source that receives imported frames. */
    assetSource: string | undefined;
    /** User-friendly display name. */
    displayName: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Server-reported state. */
    state: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
    /** RFC3339 completion timestamp. */
    completeTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Migration Center import job that ingests asset frames from uploaded
 * payload files into a source.
 *
 * `importJobId`, `location`, and `assetSource` are immutable. Display
 * name and labels update in place. Nested import data files are force-
 * deleted with the job.
 *
 * ### Creating an Import Job
 * **Example:** Bind to an upload source
 * ```typescript
 * const source = yield* GCP.MigrationCenter.Source("Inventory", {
 *   type: "SOURCE_TYPE_UPLOAD",
 * });
 * const job = yield* GCP.MigrationCenter.ImportJob("Rvtools", {
 *   assetSource: source.name,
 *   displayName: "rvtools-import",
 * });
 * ```
 *
 * @resource
 * @category MigrationCenter
 */
export const ImportJob = Resource<ImportJob>("GCP.MigrationCenter.ImportJob");

const resourceName = (project: string, location: string, importJobId: string) =>
  `${locationParent(project, location)}/importJobs/${importJobId}`;

const sourceOf = (value: string, project: string, location: string) =>
  expandParent(value, project, location, "sources");

const toAttrs = (item: mc.ImportJob, project: string, region: string) => {
  const name = item.name ?? "";
  const parsed = parseName(name, "importJobs", region);
  return {
    name,
    importJobId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    assetSource: item.assetSource,
    displayName: item.displayName,
    labels: userLabels(item.labels),
    state: item.state,
    createTime: item.createTime,
    updateTime: item.updateTime,
    completeTime: item.completeTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : mc
        .getProjectsLocationsImportJobs({
          name,
          view: "IMPORT_JOB_VIEW_FULL",
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string, region: string) =>
  mc.listProjectsLocationsImportJobs
    .pages({
      parent: `projects/${project}/locations/-`,
      pageSize: 1000,
      view: "IMPORT_JOB_VIEW_BASIC",
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.importJobs ?? [])),
      Stream.filter((item) => hasAlchemyLabelMap(item.labels)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () =>
        mc.listProjectsLocationsImportJobs
          .pages({
            parent: locationParent(project, region),
            pageSize: 1000,
            view: "IMPORT_JOB_VIEW_BASIC",
          })
          .pipe(
            Stream.flatMap((page) =>
              Stream.fromIterable(page.importJobs ?? []),
            ),
            Stream.filter((item) => hasAlchemyLabelMap(item.labels)),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
            Effect.catchTag("NotFound", () =>
              Effect.succeed([] as mc.ImportJob[]),
            ),
          ),
      ),
    );

export const ImportJobProvider = () =>
  Provider.succeed(ImportJob, {
    stables: ["name", "importJobId", "project", "location", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousSource = olds?.assetSource ?? output?.assetSource;
      const nextSource = news.assetSource;
      const sourceChanged =
        previousSource !== undefined &&
        nextSource !== undefined &&
        previousSource !== nextSource &&
        !previousSource.endsWith(`/${nextSource}`) &&
        !nextSource.endsWith(`/${previousSource}`);
      return replaceOnIdentity({
        previousId: olds?.importJobId ?? output?.importJobId,
        nextId: news.importJobId ?? olds?.importJobId ?? output?.importJobId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
          env.region,
        ),
        extra: sourceChanged,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const importJobId = yield* toPhysicalId(
        id,
        olds?.importJobId,
        output?.importJobId,
        "importjob",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, importJobId);
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
      const importJobId = yield* toPhysicalId(
        id,
        news.importJobId,
        output?.importJobId,
        "importjob",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(env.project, location, importJobId);
      const assetSource = sourceOf(news.assetSource, env.project, location);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const displayName = news.displayName ?? importJobId;

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* mc
          .createProjectsLocationsImportJobs({
            parent: locationParent(env.project, location),
            importJobId,
            body: {
              assetSource,
              displayName,
              labels: desiredLabels,
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

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const displayNameChanged = (current.displayName ?? "") !== displayName;
      const mask = fieldMask([
        labelsChanged && "labels",
        displayNameChanged && "displayName",
      ]);

      if (mask.length > 0) {
        const operation = yield* mc.patchProjectsLocationsImportJobs({
          name: current.name ?? name,
          updateMask: mask,
          body: {
            name: current.name ?? name,
            displayName,
            labels: desiredLabels,
          },
        });
        yield* waitForOperation(operation);
        current = yield* waitUntilExists(
          getByName(current.name ?? name),
          current.name ?? name,
        );
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* mc
        .deleteProjectsLocationsImportJobs({
          name: output.name,
          force: true,
        })
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
