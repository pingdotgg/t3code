import * as logging from "@distilled.cloud/gcp/logging_v2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  DEFAULT_LOCATION,
  createOwnership,
  encodeDescription,
  hasOwnershipMarker,
  jsonEqual,
  lastSegment,
  locationParent,
  ownedBy,
  parseDescription,
  parseLoggingName,
  scopeParent,
  toPhysicalId,
} from "./internal.ts";

export type FolderSavedQueryLoggingQuery = {
  /**
   * Advanced Logging Query Language filter. Max 20,000 characters.
   */
  filter?: string;
};

export type FolderSavedQueryOpsAnalyticsQuery = {
  /**
   * Log Analytics SQL query text.
   */
  sqlQueryText?: string;
};

export type FolderSavedQueryProps = {
  /**
   * Folder id (`folders/{folder}` or the numeric id). When omitted, the
   * stack project is used. Immutable — changing it replaces the query.
   */
  folderId?: string;
  /**
   * Location of the saved query. Immutable — changing it replaces the
   * query.
   * @default "global"
   */
  location?: string;
  /**
   * Saved query id (the `{query}` segment of
   * `{parent}/locations/{location}/savedQueries/{query}`). If omitted, a
   * unique name is generated. Limited to 100 characters: letters, digits,
   * underscores, hyphens, periods; first character must be alphanumeric.
   * Immutable — changing it replaces the query.
   */
  savedQueryId?: string;
  /**
   * User-specified title shown in Logs Explorer.
   */
  displayName: string;
  /**
   * Visibility. `PRIVATE` queries are owned by the creating user.
   * `SHARED` queries are owned by the parent resource.
   * @default "PRIVATE"
   */
  visibility?: "PRIVATE" | "SHARED";
  /**
   * Human-readable description. Saved queries have no labels field, so
   * Alchemy ownership is stored in a `[alchemy …]` prefix and stripped
   * from attributes.
   */
  description?: string;
  /**
   * Logs Explorer query. At least one of `loggingQuery` or
   * `opsAnalyticsQuery` is required.
   */
  loggingQuery?: FolderSavedQueryLoggingQuery;
  /**
   * Log Analytics SQL query. At least one of `loggingQuery` or
   * `opsAnalyticsQuery` is required.
   */
  opsAnalyticsQuery?: FolderSavedQueryOpsAnalyticsQuery;
};

export type FolderSavedQuery = Resource<
  "GCP.Logging.FolderSavedQuery",
  FolderSavedQueryProps,
  {
    /** Full resource name `{parent}/locations/{location}/savedQueries/{savedQueryId}`. */
    name: string;
    /** Saved query id (last path segment). */
    savedQueryId: string;
    /** Parent resource (`folders/{folder}` or `projects/{project}`). */
    parent: string;
    /** Folder id when the parent is a folder. */
    folderId: string | undefined;
    /** Location of the saved query. */
    location: string;
    /** Display title. */
    displayName: string;
    /** Visibility (`PRIVATE` or `SHARED`). */
    visibility: string;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Logs Explorer query, if set. */
    loggingQuery: FolderSavedQueryLoggingQuery | undefined;
    /** Log Analytics query, if set. */
    opsAnalyticsQuery: FolderSavedQueryOpsAnalyticsQuery | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Cloud Logging saved query owned by a folder (or the stack project).
 *
 * Saved queries have no labels field, so Alchemy stamps ownership into
 * the description for `list` / nuke. `folderId`, `savedQueryId`, and
 * `location` are identity — changing any of them replaces the query.
 * Display name, visibility, description, and query text update in place.
 *
 * ### Creating a Folder Saved Query
 * **Example:** Shared error query
 * ```typescript
 * const query = yield* GCP.Logging.FolderSavedQuery("Errors", {
 *   displayName: "application errors",
 *   visibility: "SHARED",
 *   loggingQuery: { filter: "severity>=ERROR" },
 *   description: "error log entries",
 * });
 * ```
 *
 * ### Updating a Folder Saved Query
 * **Example:** Change the filter
 * ```typescript
 * const query = yield* GCP.Logging.FolderSavedQuery("Errors", {
 *   displayName: "warnings and errors",
 *   visibility: "SHARED",
 *   loggingQuery: { filter: "severity>=WARNING" },
 *   description: "warning and error log entries",
 * });
 * ```
 *
 * @resource
 * @category Logging
 */
export const FolderSavedQuery = Resource<FolderSavedQuery>(
  "GCP.Logging.FolderSavedQuery",
);

export class FolderSavedQueryNotResolved extends Data.TaggedError(
  "GCP.Logging.FolderSavedQueryNotResolved",
)<{
  name: string;
}> {}

const resourceName = (parent: string, location: string, savedQueryId: string) =>
  `${locationParent(parent, location)}/savedQueries/${savedQueryId}`;

const folderIdOf = (parent: string) =>
  parent.startsWith("folders/") ? lastSegment(parent) : undefined;

const toAttrs = (
  query: logging.SavedQuery,
  parent: string,
  location: string,
) => {
  const parsed = parseLoggingName(query.name ?? "");
  const savedQueryId = parsed.savedQueryId ?? lastSegment(query.name ?? "");
  const resolvedParent = parsed.parent || parent;
  const resolvedLocation = parsed.location ?? location;
  const description = parseDescription(query.description);
  return {
    name:
      query.name ??
      (savedQueryId
        ? resourceName(resolvedParent, resolvedLocation, savedQueryId)
        : ""),
    savedQueryId,
    parent: resolvedParent,
    folderId: folderIdOf(resolvedParent),
    location: resolvedLocation,
    displayName: query.displayName ?? "",
    visibility: query.visibility ?? "PRIVATE",
    description: description.description,
    loggingQuery: query.loggingQuery
      ? { filter: query.loggingQuery.filter }
      : undefined,
    opsAnalyticsQuery: query.opsAnalyticsQuery
      ? { sqlQueryText: query.opsAnalyticsQuery.sqlQueryText }
      : undefined,
    createTime: query.createTime,
    updateTime: query.updateTime,
  };
};

const getByName = (name: string) =>
  logging
    .getFoldersLocationsSavedQueries({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const toBody = (
  news: FolderSavedQueryProps,
  description: string,
): logging.SavedQuery => ({
  displayName: news.displayName,
  visibility: news.visibility ?? "PRIVATE",
  description,
  loggingQuery: news.loggingQuery,
  opsAnalyticsQuery: news.opsAnalyticsQuery,
});

export const FolderSavedQueryProvider = () =>
  Provider.succeed(FolderSavedQuery, {
    stables: [
      "name",
      "savedQueryId",
      "parent",
      "folderId",
      "location",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.savedQueryId ?? output?.savedQueryId;
      const idChanged =
        previousId !== undefined &&
        news.savedQueryId !== undefined &&
        news.savedQueryId !== previousId;
      const previousLocation = olds?.location ?? output?.location;
      const locationChanged =
        previousLocation !== undefined &&
        news.location !== undefined &&
        news.location !== previousLocation;
      const previousFolder = olds?.folderId ?? output?.folderId;
      const folderChanged =
        news.folderId !== undefined && news.folderId !== previousFolder;
      if (!idChanged && !locationChanged && !folderChanged) return undefined;
      return { action: "replace" as const, deleteFirst: false };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const parent = scopeParent(
        env.project,
        olds?.folderId ?? output?.folderId,
      );
      const location = olds?.location ?? output?.location ?? DEFAULT_LOCATION;
      const savedQueryId = yield* toPhysicalId(
        id,
        olds?.savedQueryId,
        output?.savedQueryId,
        "q",
      );
      const name = output?.name ?? resourceName(parent, location, savedQueryId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, parent, location);
      const { labels } = parseDescription(existing.description);
      return (yield* ownedBy(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* logging.listFoldersLocationsSavedQueries
          .pages({
            parent: `projects/${env.project}/locations/-`,
            pageSize: 1000,
          })
          .pipe(
            Stream.flatMap((page) =>
              Stream.fromIterable(page.savedQueries ?? []),
            ),
            Stream.filter((query) => hasOwnershipMarker(query.description)),
            Stream.map((query) =>
              toAttrs(
                query,
                parseLoggingName(query.name ?? "").parent ||
                  `projects/${env.project}`,
                parseLoggingName(query.name ?? "").location ?? DEFAULT_LOCATION,
              ),
            ),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const parent = scopeParent(
        env.project,
        news.folderId ?? output?.folderId,
      );
      const location = news.location ?? output?.location ?? DEFAULT_LOCATION;
      const savedQueryId = yield* toPhysicalId(
        id,
        news.savedQueryId,
        output?.savedQueryId,
        "q",
      );
      const name = resourceName(parent, location, savedQueryId);
      const ownership = yield* createOwnership(id);
      const desiredDescription = encodeDescription(ownership, news.description);
      const desiredVisibility = news.visibility ?? "PRIVATE";

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* logging
          .createFoldersLocationsSavedQueries({
            parent: locationParent(parent, location),
            savedQueryId,
            body: toBody(news, desiredDescription),
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new FolderSavedQueryNotResolved({ name });
      }

      const displayNameChanged =
        (current.displayName ?? "") !== news.displayName;
      const descriptionChanged =
        (current.description ?? "") !== desiredDescription;
      const visibilityChanged =
        (current.visibility ?? "PRIVATE") !== desiredVisibility;
      const loggingChanged = !jsonEqual(
        current.loggingQuery ?? null,
        news.loggingQuery ?? null,
      );
      const analyticsChanged = !jsonEqual(
        current.opsAnalyticsQuery?.sqlQueryText ?? null,
        news.opsAnalyticsQuery?.sqlQueryText ?? null,
      );

      const updateMask = [
        displayNameChanged ? "displayName" : undefined,
        descriptionChanged ? "description" : undefined,
        visibilityChanged ? "visibility" : undefined,
        loggingChanged ? "loggingQuery" : undefined,
        analyticsChanged ? "opsAnalyticsQuery" : undefined,
      ].filter((field): field is string => field !== undefined);

      if (updateMask.length > 0) {
        current = yield* logging.patchFoldersLocationsSavedQueries({
          name: current.name ?? name,
          updateMask: updateMask.join(","),
          body: toBody(news, desiredDescription),
        });
      }

      return toAttrs(current, parent, location);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* logging
        .deleteFoldersLocationsSavedQueries({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
