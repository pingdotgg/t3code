import * as vault from "@distilled.cloud/gcp/vault_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  encodeOwnershipLine,
  findExportByName,
  findOwnedExport,
  getExport,
  hasOwnershipMarker,
  ignoreMissing,
  jsonEqual,
  listActiveMatters,
  listExports,
  MAX_EXPORT_NAME_LENGTH,
  ownedByAlchemy,
  ownershipLabels,
  parseOwnership,
  toGeneratedName,
} from "./internal.ts";

export type MattersExportProps = {
  /**
   * Parent matter id. Immutable — changing it replaces the export.
   */
  matterId: string;
  /**
   * Server-assigned export id. Leave blank on create. Immutable —
   * changing it replaces the export.
   */
  exportId?: string;
  /**
   * Export name (max 100 characters including Alchemy's ownership
   * marker). Do not use `~!$'(),;@:/?`. Vault exports have no labels
   * field, so ownership is stored in a `[alchemy …]` prefix and stripped
   * from attributes. Vault has no export update API — changing the name
   * replaces the export.
   */
  name?: string;
  /**
   * Search query used to create the export. Required on create. Vault
   * has no export update API — changing the query replaces the export.
   */
  query: vault.Query;
  /**
   * Additional export options (format, region). Vault has no export
   * update API — changing options replaces the export.
   */
  exportOptions?: vault.ExportOptions;
};

export type MattersExport = Resource<
  "GCP.Vault.MattersExport",
  MattersExportProps,
  {
    /** Server-assigned export id. */
    exportId: string;
    /** Parent matter id. */
    matterId: string;
    /** Project id used when the export was reconciled. */
    project: string;
    /** User-facing name with the Alchemy ownership prefix stripped. */
    name: string | undefined;
    /** Search query. */
    query: vault.Query | undefined;
    /** Export options. */
    exportOptions: vault.ExportOptions | undefined;
    /** Export status (`IN_PROGRESS`, `COMPLETED`, `FAILED`). */
    status: string | undefined;
    /** RFC3339 create timestamp. */
    createTime: string | undefined;
    /** Parent export id when this is a child export. */
    parentExportId: string | undefined;
    /** Cloud Storage sink for export files. */
    cloudStorageSink: vault.CloudStorageSink | undefined;
    /** Progress and size. */
    stats: vault.ExportStats | undefined;
  },
  never,
  Providers
>;

/**
 * A Google Vault export on a matter.
 *
 * Vault exports have no labels field, so Alchemy stamps ownership into
 * `name` for `list` / nuke. There is no update API — changing the query,
 * options, or name replaces the export (delete-first).
 *
 * ### Creating an Export
 * **Example:** Mail export
 * ```typescript
 * const exported = yield* GCP.Vault.MattersExport("Mail", {
 *   matterId: matter.matterId,
 *   query: {
 *     corpus: "MAIL",
 *     dataScope: "ALL_DATA",
 *     searchMethod: "ACCOUNT",
 *     accountInfo: { emails: ["user@example.com"] },
 *   },
 *   exportOptions: { mailOptions: { exportFormat: "MBOX" } },
 * });
 * ```
 *
 * **Example:** Drive export with a name
 * ```typescript
 * const exported = yield* GCP.Vault.MattersExport("Drive", {
 *   matterId: matter.matterId,
 *   name: "drive-dump",
 *   query: {
 *     corpus: "DRIVE",
 *     dataScope: "HELD_DATA",
 *     searchMethod: "ENTIRE_ORG",
 *   },
 * });
 * ```
 *
 * @resource
 * @category Vault
 */
export const MattersExport = Resource<MattersExport>("GCP.Vault.MattersExport");

export class MattersExportNotResolved extends Data.TaggedError(
  "GCP.Vault.MattersExportNotResolved",
)<{
  matterId: string;
  exportId: string;
}> {}

const toAttrs = (item: vault.Export, project: string) => ({
  exportId: item.id ?? "",
  matterId: item.matterId ?? "",
  project,
  name: parseOwnership(item.name).text,
  query: item.query,
  exportOptions: item.exportOptions,
  status: item.status,
  createTime: item.createTime,
  parentExportId: item.parentExportId,
  cloudStorageSink: item.cloudStorageSink,
  stats: item.stats,
});

export const MattersExportProvider = () =>
  Provider.succeed(MattersExport, {
    stables: ["exportId", "matterId", "project", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousMatter = olds?.matterId ?? output?.matterId;
      if (previousMatter !== undefined && news.matterId !== previousMatter) {
        return { action: "replace" as const, deleteFirst: true };
      }
      const previousId = olds?.exportId ?? output?.exportId;
      if (
        previousId !== undefined &&
        news.exportId !== undefined &&
        news.exportId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      const previousName = olds?.name ?? output?.name;
      if (
        news.name !== undefined &&
        previousName !== undefined &&
        news.name !== previousName
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      const previousQuery = olds?.query ?? output?.query;
      if (
        previousQuery !== undefined &&
        !jsonEqual(previousQuery, news.query)
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      const previousOptions = olds?.exportOptions ?? output?.exportOptions;
      if (
        news.exportOptions !== undefined &&
        previousOptions !== undefined &&
        !jsonEqual(previousOptions, news.exportOptions)
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const matterId = olds?.matterId ?? output?.matterId ?? "";
      const exportId = olds?.exportId ?? output?.exportId ?? "";
      let existing = yield* getExport(matterId, exportId);
      if (existing === undefined) {
        const ownership = yield* ownershipLabels(id);
        const name = encodeOwnershipLine(
          ownership,
          olds?.name ?? output?.name,
          MAX_EXPORT_NAME_LENGTH,
        );
        existing = yield* findExportByName(matterId, name);
      }
      if (existing === undefined) {
        existing = yield* findOwnedExport(id, matterId);
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* ownedByAlchemy(id, existing.name))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const matters = yield* listActiveMatters();
        const pages = yield* Effect.forEach(
          matters,
          (matter) =>
            listExports(matter.matterId ?? "").pipe(
              Effect.map((items) =>
                items
                  .filter((item) => hasOwnershipMarker(item.name))
                  .map((item) => toAttrs(item, env.project)),
              ),
            ),
          { concurrency: 4 },
        );
        return pages.flat();
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const matterId = news.matterId;
      const ownership = yield* ownershipLabels(id);
      const displayName = yield* toGeneratedName(
        id,
        news.name,
        output?.name,
        40,
      );
      const name = encodeOwnershipLine(
        ownership,
        displayName,
        MAX_EXPORT_NAME_LENGTH,
      );
      const desired: vault.Export = {
        name,
        query: news.query,
        exportOptions: news.exportOptions,
      };

      let current = yield* getExport(
        matterId,
        news.exportId ?? output?.exportId ?? "",
      );
      if (current === undefined) {
        current = yield* findExportByName(matterId, name);
      }
      if (current === undefined) {
        current = yield* findOwnedExport(id, matterId);
      }

      if (current === undefined) {
        const created = yield* vault
          .createMattersExports({
            matterId,
            body: desired,
          })
          .pipe(
            Effect.catchTag("Conflict", () => findExportByName(matterId, name)),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new MattersExportNotResolved({
          matterId,
          exportId: news.exportId ?? output?.exportId ?? name,
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (output.matterId.length === 0 || output.exportId.length === 0) {
        return;
      }
      yield* ignoreMissing(
        vault.deleteMattersExports({
          matterId: output.matterId,
          exportId: output.exportId,
        }),
      );
    }),
  });
