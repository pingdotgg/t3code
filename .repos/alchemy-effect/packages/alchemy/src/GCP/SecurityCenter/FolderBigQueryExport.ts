import * as scc from "@distilled.cloud/gcp/securitycenter_v1";
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
  encodeDescription,
  folderIdOf,
  folderParent,
  hasOwnershipMarker,
  lastSegment,
  ownedByAlchemy,
  parseName,
  parseOwnership,
  replaceOn,
  resolveFolder,
  sameText,
  SecuritycenterNotResolved,
  toPhysicalId,
  tryResolveFolder,
  updateMaskOf,
} from "./internal.ts";

export type FolderBigQueryExportProps = {
  /**
   * Export id (the `{export}` segment of
   * `folders/{folder}/bigQueryExports/{export}`). If omitted, a unique id
   * is generated from the stack, stage, and logical id. Letters, digits,
   * and hyphens; max 63 characters. Immutable — changing it replaces the
   * export.
   */
  exportId?: string;
  /**
   * Parent folder (`folders/{folder}` or the numeric id). Defaults to
   * the project's Resource Manager folder ancestor.
   * Immutable — changing it replaces the export.
   */
  folder?: string;
  /**
   * Destination dataset
   * (`projects/{project}/datasets/{dataset}`).
   */
  dataset: string;
  /**
   * Finding filter. Empty or omitted exports every finding under the
   * parent.
   */
  filter?: string;
  /**
   * Human-readable description. BigQuery exports have no labels field, so
   * Alchemy ownership is stored in a `[alchemy …]` prefix and stripped
   * from attributes.
   */
  description?: string;
};

export type FolderBigQueryExport = Resource<
  "GCP.SecurityCenter.FolderBigQueryExport",
  FolderBigQueryExportProps,
  {
    /** Full resource name `folders/{folder}/bigQueryExports/{export}`. */
    name: string;
    /** Export id (last path segment). */
    exportId: string;
    /** Folder resource name. */
    folder: string;
    /** Folder id. */
    folderId: string;
    /** Project id of the deploying stack. */
    project: string;
    /** Destination dataset. */
    dataset: string;
    /** Finding filter. */
    filter: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Principal Security Command Center uses to write to the dataset. */
    principal: string | undefined;
    /** Most recent editor of the export. */
    mostRecentEditor: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A folder-scoped Security Command Center BigQuery export.
 *
 * Exports have no labels field — Alchemy stamps ownership into the
 * description so `list` / nuke can find them. Export id and folder are
 * identity. Dataset, filter, and description update in place.
 *
 * ### Creating a BigQuery Export
 * **Example:** Export active findings to a dataset
 * ```typescript
 * const dataset = yield* GCP.BigQuery.Dataset("SccFindings", {
 *   location: "US",
 *   forceDestroy: true,
 * });
 * const exp = yield* GCP.SecurityCenter.FolderBigQueryExport("Findings", {
 *   dataset: `projects/${dataset.project}/datasets/${dataset.datasetId}`,
 *   filter: 'state="ACTIVE"',
 *   description: "active findings",
 * });
 * ```
 *
 * **Example:** Named export on an explicit folder
 * ```typescript
 * const exp = yield* GCP.SecurityCenter.FolderBigQueryExport("Findings", {
 *   folder: "folders/123456789",
 *   exportId: "active-findings",
 *   dataset: "projects/my-project/datasets/scc",
 * });
 * ```
 *
 * @resource
 * @category SecurityCenter
 */
export const FolderBigQueryExport = Resource<FolderBigQueryExport>(
  "GCP.SecurityCenter.FolderBigQueryExport",
);

const resourceName = (folder: string, exportId: string) =>
  `${folder}/bigQueryExports/${exportId}`;

const toAttrs = (
  exp: scc.GoogleCloudSecuritycenterV1BigQueryExport,
  folder: string,
  project: string,
) => {
  const name = exp.name ?? "";
  const parsed = parseName(name, "bigQueryExports");
  const ownership = parseOwnership(exp.description);
  return {
    name,
    exportId: parsed.id || lastSegment(name),
    folder,
    folderId: folderIdOf(folder),
    project,
    dataset: exp.dataset ?? "",
    filter: exp.filter,
    description: ownership.text,
    principal: exp.principal,
    mostRecentEditor: exp.mostRecentEditor,
    createTime: exp.createTime,
    updateTime: exp.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : scc
        .getFoldersBigQueryExports({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const FolderBigQueryExportProvider = () =>
  Provider.succeed(FolderBigQueryExport, {
    stables: [
      "name",
      "exportId",
      "folder",
      "folderId",
      "project",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      return (
        replaceOn(olds?.exportId ?? output?.exportId, news.exportId) ??
        replaceOn(
          olds?.folder ?? output?.folder,
          news.folder !== undefined ? folderParent(news.folder) : undefined,
        )
      );
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const folder = yield* resolveFolder(
        olds?.folder ?? output?.folder,
        output?.folder,
      );
      const exportId = yield* toPhysicalId(
        id,
        olds?.exportId,
        output?.exportId,
      );
      const name = output?.name ?? resourceName(folder, exportId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, folder, env.project);
      return (yield* ownedByAlchemy(id, existing.description))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const folder = yield* tryResolveFolder();
        if (folder === undefined) return [];
        return yield* scc.listFoldersBigQueryExports
          .pages({ parent: folder, pageSize: 100 })
          .pipe(
            Stream.flatMap((page) =>
              Stream.fromIterable(page.bigQueryExports ?? []),
            ),
            Stream.filter((exp) => hasOwnershipMarker(exp.description)),
            Stream.map((exp) => toAttrs(exp, folder, env.project)),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
            Effect.catchTag("NotFound", () => Effect.succeed([])),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const folder = yield* resolveFolder(news.folder, output?.folder);
      const exportId = yield* toPhysicalId(id, news.exportId, output?.exportId);
      const name = resourceName(folder, exportId);
      const ownership = yield* createInternalLabels(id);
      const description = encodeDescription(ownership, news.description);
      const dataset = news.dataset;
      const filter = news.filter;

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* scc
          .createFoldersBigQueryExports({
            parent: folder,
            bigQueryExportId: exportId,
            body: { dataset, filter, description },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new SecuritycenterNotResolved({ name });
      }

      const currentName = current.name ?? name;
      const updateMask = updateMaskOf(
        !sameText(current.dataset, dataset) ? "dataset" : undefined,
        !sameText(current.filter, filter) ? "filter" : undefined,
        !sameText(current.description, description) ? "description" : undefined,
      );

      if (updateMask.length > 0) {
        current = yield* scc.patchFoldersBigQueryExports({
          name: currentName,
          updateMask,
          body: { dataset, filter, description },
        });
      }

      return toAttrs(current, folder, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* scc
        .deleteFoldersBigQueryExports({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
