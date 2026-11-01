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
  encodeOwnershipLine,
  expandParent,
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

export type ImportDataFileFormat = mc.ImportDataFileFormatEnum | (string & {});
export type ImportDataFileState = mc.ImportDataFileStateEnum | (string & {});

export type ImportJobsImportDataFileProps = {
  /**
   * Parent import job. Full name
   * `projects/{project}/locations/{location}/importJobs/{importJob}` or
   * the import job id (combined with `location`). Immutable — changing it
   * replaces the file.
   */
  importJob: string;
  /**
   * Region used when `importJob` is a bare id.
   * @default the stack's GCP region (`GCP.Region`, else the profile
   *   region, else `us-central1`)
   */
  location?: string;
  /**
   * Import data file id (the `{importDataFile}` segment). If omitted, a
   * unique RFC1035 name is generated. Immutable — changing it replaces
   * the file.
   */
  importDataFileId?: string;
  /**
   * Payload format. Immutable — changing it replaces the file.
   * @default "IMPORT_JOB_FORMAT_RVTOOLS_CSV"
   */
  format?: ImportDataFileFormat;
  /**
   * User-friendly display name. Maximum length is 63 characters including
   * Alchemy's ownership marker. Import data files have no labels field,
   * so ownership is stored in a `[alchemy …]` prefix and stripped from
   * attributes.
   */
  displayName?: string;
};

export type ImportJobsImportDataFile = Resource<
  "GCP.MigrationCenter.ImportJobsImportDataFile",
  ImportJobsImportDataFileProps,
  {
    /** Full resource name. */
    name: string;
    /** Import data file id (last path segment). */
    importDataFileId: string;
    /** Parent import job resource name. */
    importJob: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Payload format. */
    format: string | undefined;
    /** User display name with the Alchemy ownership prefix stripped. */
    displayName: string | undefined;
    /** Server-reported state. */
    state: string | undefined;
    /** Signed upload URI. */
    signedUri: string | undefined;
    /** Upload URI expiration. */
    uriExpirationTime: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A payload file attached to a Migration Center import job. Creating the
 * file returns a signed URI that the client uploads inventory CSV/XLSX
 * into.
 *
 * Import data files have no labels field — Alchemy stamps ownership into
 * the display name so `list` / nuke can find them. The API has no patch
 * method; changing format or display name replaces the file.
 *
 * ### Creating an Import Data File
 * **Example:** RVTools CSV payload
 * ```typescript
 * const job = yield* GCP.MigrationCenter.ImportJob("Rvtools", {
 *   assetSource: source.name,
 * });
 * const file = yield* GCP.MigrationCenter.ImportJobsImportDataFile("Payload", {
 *   importJob: job.name,
 *   format: "IMPORT_JOB_FORMAT_RVTOOLS_CSV",
 *   displayName: "inventory",
 * });
 * ```
 *
 * @resource
 * @category MigrationCenter
 */
export const ImportJobsImportDataFile = Resource<ImportJobsImportDataFile>(
  "GCP.MigrationCenter.ImportJobsImportDataFile",
);

const DEFAULT_FORMAT: ImportDataFileFormat = "IMPORT_JOB_FORMAT_RVTOOLS_CSV";

const jobNameOf = (value: string, project: string, location: string) =>
  expandParent(value, project, location, "importJobs");

const resourceName = (importJob: string, importDataFileId: string) =>
  `${importJob}/importDataFiles/${importDataFileId}`;

const toAttrs = (item: mc.ImportDataFile, project: string, region: string) => {
  const name = item.name ?? "";
  const parsed = parseName(name, "importDataFiles", region);
  const ownership = parseOwnership(item.displayName);
  return {
    name,
    importDataFileId: parsed.id,
    importJob: parsed.parent,
    project: parsed.project || project,
    location: parsed.location,
    format: item.format,
    displayName: ownership.text,
    state: item.state,
    signedUri: item.uploadFileInfo?.signedUri,
    uriExpirationTime: item.uploadFileInfo?.uriExpirationTime,
    createTime: item.createTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : mc
        .getProjectsLocationsImportJobsImportDataFiles({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listFiles = (parent: string) =>
  mc.listProjectsLocationsImportJobsImportDataFiles
    .pages({ parent, pageSize: 1000 })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.importDataFiles ?? [])),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () =>
        Effect.succeed([] as mc.ImportDataFile[]),
      ),
    );

const listJobs = (project: string, region: string) =>
  mc.listProjectsLocationsImportJobs
    .pages({
      parent: `projects/${project}/locations/-`,
      pageSize: 1000,
      view: "IMPORT_JOB_VIEW_BASIC",
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.importJobs ?? [])),
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
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
            Effect.catchTag("NotFound", () =>
              Effect.succeed([] as mc.ImportJob[]),
            ),
          ),
      ),
    );

const listOwned = (project: string, region: string) =>
  Effect.gen(function* () {
    const jobs = yield* listJobs(project, region);
    const files: mc.ImportDataFile[] = [];
    for (const job of jobs) {
      if (job.name === undefined) continue;
      const nested = yield* listFiles(job.name);
      for (const file of nested) {
        if (hasOwnershipMarker(file.displayName)) files.push(file);
      }
    }
    return files;
  });

export const ImportJobsImportDataFileProvider = () =>
  Provider.succeed(ImportJobsImportDataFile, {
    stables: [
      "name",
      "importDataFileId",
      "importJob",
      "project",
      "location",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousFormat = olds?.format ?? output?.format ?? DEFAULT_FORMAT;
      const nextFormat = news.format ?? previousFormat;
      const previousJob = olds?.importJob ?? output?.importJob;
      const nextJob = news.importJob;
      return replaceOnIdentity({
        previousId: olds?.importDataFileId ?? output?.importDataFileId,
        nextId:
          news.importDataFileId ??
          olds?.importDataFileId ??
          output?.importDataFileId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
          env.region,
        ),
        previousParent: previousJob,
        nextParent: nextJob,
        extra: previousFormat !== nextFormat,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const importJob = jobNameOf(
        olds?.importJob ?? output?.importJob ?? "",
        env.project,
        location,
      );
      const importDataFileId = yield* toPhysicalId(
        id,
        olds?.importDataFileId,
        output?.importDataFileId,
        "importdata",
      );
      const name =
        output?.name ??
        (importJob.length > 0 ? resourceName(importJob, importDataFileId) : "");
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region);
      return (yield* ownedByAlchemy(id, existing.displayName))
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
      const importJob = jobNameOf(news.importJob, env.project, location);
      const importDataFileId = yield* toPhysicalId(
        id,
        news.importDataFileId,
        output?.importDataFileId,
        "importdata",
      );
      const name = resourceName(importJob, importDataFileId);
      const ownership = yield* createInternalLabels(id);
      const displayName = encodeOwnershipLine(ownership, news.displayName);
      const format = news.format ?? DEFAULT_FORMAT;

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* mc
          .createProjectsLocationsImportJobsImportDataFiles({
            parent: importJob,
            importDataFileId,
            body: {
              displayName,
              format,
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
        .deleteProjectsLocationsImportJobsImportDataFiles({
          name: output.name,
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
