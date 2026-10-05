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
  findOwnedSavedQuery,
  findSavedQueryByName,
  getSavedQuery,
  hasOwnershipMarker,
  ignoreMissing,
  jsonEqual,
  listActiveMatters,
  listSavedQueries,
  MAX_SAVED_QUERY_NAME_LENGTH,
  ownedByAlchemy,
  ownershipLabels,
  parseOwnership,
  toGeneratedName,
} from "./internal.ts";

export type MattersSavedQueryProps = {
  /**
   * Parent matter id. Immutable — changing it replaces the saved query.
   */
  matterId: string;
  /**
   * Server-assigned saved query id. Leave blank on create. Immutable —
   * changing it replaces the saved query.
   */
  savedQueryId?: string;
  /**
   * Display name (max 100 characters including Alchemy's ownership
   * marker). Vault saved queries have no labels field, so ownership is
   * stored in a `[alchemy …]` prefix and stripped from attributes. Vault
   * has no saved-query update API — changing the name replaces the
   * query.
   */
  displayName?: string;
  /**
   * Search parameters. Required on create. Vault has no saved-query
   * update API — changing the query replaces the saved query.
   */
  query: vault.Query;
};

export type MattersSavedQuery = Resource<
  "GCP.Vault.MattersSavedQuery",
  MattersSavedQueryProps,
  {
    /** Server-assigned saved query id. */
    savedQueryId: string;
    /** Parent matter id. */
    matterId: string;
    /** Project id used when the saved query was reconciled. */
    project: string;
    /** User-facing name with the Alchemy ownership prefix stripped. */
    displayName: string | undefined;
    /** Search parameters. */
    query: vault.Query | undefined;
    /** RFC3339 create timestamp. */
    createTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Google Vault saved query on a matter.
 *
 * Vault saved queries have no labels field, so Alchemy stamps ownership
 * into `displayName` for `list` / nuke. There is no update API — changing
 * the query or display name replaces the saved query (delete-first).
 *
 * ### Creating a Saved Query
 * **Example:** Mail search
 * ```typescript
 * const saved = yield* GCP.Vault.MattersSavedQuery("Contracts", {
 *   matterId: matter.matterId,
 *   query: {
 *     corpus: "MAIL",
 *     dataScope: "ALL_DATA",
 *     searchMethod: "ACCOUNT",
 *     accountInfo: { emails: ["user@example.com"] },
 *     terms: "subject:contract",
 *   },
 * });
 * ```
 *
 * **Example:** Named Drive search
 * ```typescript
 * const saved = yield* GCP.Vault.MattersSavedQuery("Drive", {
 *   matterId: matter.matterId,
 *   displayName: "shared-drives",
 *   query: {
 *     corpus: "DRIVE",
 *     dataScope: "ALL_DATA",
 *     searchMethod: "ENTIRE_ORG",
 *   },
 * });
 * ```
 *
 * @resource
 * @category Vault
 */
export const MattersSavedQuery = Resource<MattersSavedQuery>(
  "GCP.Vault.MattersSavedQuery",
);

export class MattersSavedQueryNotResolved extends Data.TaggedError(
  "GCP.Vault.MattersSavedQueryNotResolved",
)<{
  matterId: string;
  savedQueryId: string;
}> {}

const toAttrs = (item: vault.SavedQuery, project: string) => ({
  savedQueryId: item.savedQueryId ?? "",
  matterId: item.matterId ?? "",
  project,
  displayName: parseOwnership(item.displayName).text,
  query: item.query,
  createTime: item.createTime,
});

export const MattersSavedQueryProvider = () =>
  Provider.succeed(MattersSavedQuery, {
    stables: ["savedQueryId", "matterId", "project", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousMatter = olds?.matterId ?? output?.matterId;
      if (previousMatter !== undefined && news.matterId !== previousMatter) {
        return { action: "replace" as const, deleteFirst: true };
      }
      const previousId = olds?.savedQueryId ?? output?.savedQueryId;
      if (
        previousId !== undefined &&
        news.savedQueryId !== undefined &&
        news.savedQueryId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      const previousName = olds?.displayName ?? output?.displayName;
      if (
        news.displayName !== undefined &&
        previousName !== undefined &&
        news.displayName !== previousName
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
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const matterId = olds?.matterId ?? output?.matterId ?? "";
      const savedQueryId = olds?.savedQueryId ?? output?.savedQueryId ?? "";
      let existing = yield* getSavedQuery(matterId, savedQueryId);
      if (existing === undefined) {
        const ownership = yield* ownershipLabels(id);
        const displayName = encodeOwnershipLine(
          ownership,
          olds?.displayName ?? output?.displayName,
          MAX_SAVED_QUERY_NAME_LENGTH,
        );
        existing = yield* findSavedQueryByName(matterId, displayName);
      }
      if (existing === undefined) {
        existing = yield* findOwnedSavedQuery(id, matterId);
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* ownedByAlchemy(id, existing.displayName))
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
            listSavedQueries(matter.matterId ?? "").pipe(
              Effect.map((items) =>
                items
                  .filter((item) => hasOwnershipMarker(item.displayName))
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
      const generated = yield* toGeneratedName(
        id,
        news.displayName,
        output?.displayName,
        40,
      );
      const displayName = encodeOwnershipLine(
        ownership,
        generated,
        MAX_SAVED_QUERY_NAME_LENGTH,
      );
      const desired: vault.SavedQuery = {
        displayName,
        query: news.query,
      };

      let current = yield* getSavedQuery(
        matterId,
        news.savedQueryId ?? output?.savedQueryId ?? "",
      );
      if (current === undefined) {
        current = yield* findSavedQueryByName(matterId, displayName);
      }
      if (current === undefined) {
        current = yield* findOwnedSavedQuery(id, matterId);
      }

      if (current === undefined) {
        const created = yield* vault
          .createMattersSavedQueries({
            matterId,
            body: desired,
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              findSavedQueryByName(matterId, displayName),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new MattersSavedQueryNotResolved({
          matterId,
          savedQueryId:
            news.savedQueryId ?? output?.savedQueryId ?? displayName,
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (output.matterId.length === 0 || output.savedQueryId.length === 0) {
        return;
      }
      yield* ignoreMissing(
        vault.deleteMattersSavedQueries({
          matterId: output.matterId,
          savedQueryId: output.savedQueryId,
        }),
      );
    }),
  });
