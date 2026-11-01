import * as logging from "@distilled.cloud/gcp/logging_v2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels, hasAlchemyLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  encodeDescription,
  hasOwnershipMarker,
  jsonEqual,
  lastSegment,
  parseDescription,
} from "./ownership.ts";

const MAX_NAME_LENGTH = 100;
const DEFAULT_LOCATION = "global";
const DEFAULT_VISIBILITY = "PRIVATE" as const;

export type SavedQuerySummaryField = {
  /**
   * LogEntry field to include in the Logs Explorer summary line
   * (e.g. `resource.type`).
   */
  field: string;
};

export type SavedQueryLoggingQuery = {
  /**
   * Logging Query Language filter. Maximum 20000 characters.
   */
  filter: string;
  /**
   * Summary-field start character offset.
   */
  summaryFieldStart?: number;
  /**
   * Summary-field end character offset.
   */
  summaryFieldEnd?: number;
  /**
   * Fields shown in the Logs Explorer summary line.
   */
  summaryFields?: SavedQuerySummaryField[];
};

export type SavedQueryOpsAnalyticsQuery = {
  /**
   * Log Analytics SQL query text.
   */
  sqlQueryText: string;
};

export type SavedQueryProps = {
  /**
   * Saved query id (the `{query}` segment of
   * `projects/{project}/locations/{location}/savedQueries/{query}`). If
   * omitted, a unique name is generated from the stack, stage, and
   * logical id. Limited to 100 characters: letters, digits, underscores,
   * hyphens, periods; first character must be alphanumeric. Immutable —
   * changing it replaces the saved query.
   */
  savedQueryId?: string;
  /**
   * Location that stores the saved query. Immutable after create —
   * changing it replaces the query.
   * @default "global"
   */
  location?: string;
  /**
   * Title shown in Logs Explorer.
   * @default the generated `savedQueryId`
   */
  displayName?: string;
  /**
   * Who can see the query. `PRIVATE` is owned by the creating identity.
   * @default "PRIVATE"
   */
  visibility?: "PRIVATE" | "SHARED";
  /**
   * Logs Explorer / Logging API query. At least one of `loggingQuery`
   * or `opsAnalyticsQuery` is required.
   */
  loggingQuery?: SavedQueryLoggingQuery;
  /**
   * Log Analytics SQL query. At least one of `loggingQuery` or
   * `opsAnalyticsQuery` is required.
   */
  opsAnalyticsQuery?: SavedQueryOpsAnalyticsQuery;
  /**
   * Human-readable description. Saved queries have no labels field, so
   * Alchemy ownership is stored in a `[alchemy …]` prefix and stripped
   * from attributes.
   */
  description?: string;
};

export type SavedQuery = Resource<
  "GCP.Logging.SavedQuery",
  SavedQueryProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/savedQueries/{savedQueryId}`. */
    name: string;
    /** Saved query id (last path segment). */
    savedQueryId: string;
    /** Project id. */
    project: string;
    /** Location that stores the query. */
    location: string;
    /** Title shown in Logs Explorer. */
    displayName: string | undefined;
    /** Visibility (`PRIVATE` or `SHARED`). */
    visibility: string | undefined;
    /** Logs Explorer query, if set. */
    loggingQuery: SavedQueryLoggingQuery | undefined;
    /** Log Analytics query, if set. */
    opsAnalyticsQuery: SavedQueryOpsAnalyticsQuery | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Cloud Logging saved query for Logs Explorer or Log Analytics.
 *
 * Saved queries have no labels field, so Alchemy stamps ownership into
 * the description for `list` / nuke. `savedQueryId` and `location` are
 * identity — changing either replaces the query. Display name, visibility,
 * description, and query body update in place.
 *
 * ### Creating a Saved Query
 * **Example:** Generated name, private Logs Explorer query
 * ```typescript
 * const query = yield* GCP.Logging.SavedQuery("Errors", {
 *   displayName: "application errors",
 *   loggingQuery: { filter: "severity>=ERROR" },
 * });
 * ```
 *
 * **Example:** Named shared query
 * ```typescript
 * const query = yield* GCP.Logging.SavedQuery("Errors", {
 *   savedQueryId: "app-errors",
 *   displayName: "application errors",
 *   visibility: "SHARED",
 *   loggingQuery: { filter: "severity>=ERROR" },
 * });
 * ```
 *
 * ### Updating a Saved Query
 * **Example:** Change the filter
 * ```typescript
 * const query = yield* GCP.Logging.SavedQuery("Errors", {
 *   displayName: "warnings and errors",
 *   loggingQuery: { filter: "severity>=WARNING" },
 * });
 * ```
 *
 * @resource
 * @category Logging
 */
export const SavedQuery = Resource<SavedQuery>("GCP.Logging.SavedQuery");

export class SavedQueryNotResolved extends Data.TaggedError(
  "GCP.Logging.SavedQueryNotResolved",
)<{
  name: string;
}> {}

const parseQueryName = (name: string) => {
  const match = name.match(
    /^projects\/([^/]+)\/locations\/([^/]+)\/savedQueries\/([^/]+)$/,
  );
  if (!match) return undefined;
  return {
    project: match[1]!,
    location: match[2]!,
    savedQueryId: match[3]!,
  };
};

const resourceName = (
  project: string,
  location: string,
  savedQueryId: string,
) => `projects/${project}/locations/${location}/savedQueries/${savedQueryId}`;

const savedQueryIdOf = (query: logging.SavedQuery, fallback?: string) => {
  const parsed = parseQueryName(query.name ?? "");
  return parsed?.savedQueryId ?? fallback ?? lastSegment(query.name ?? "");
};

const toId = (
  id: string,
  savedQueryId: string | undefined,
  existing?: string,
) =>
  Effect.gen(function* () {
    if (savedQueryId !== undefined) return savedQueryId;
    if (existing !== undefined) return existing;
    const generated = yield* createPhysicalName({
      id,
      maxLength: MAX_NAME_LENGTH,
      lowercase: true,
    });
    return /^[a-z0-9]/.test(generated)
      ? generated
      : `q${generated}`.slice(0, MAX_NAME_LENGTH);
  });

const loggingQueryOf = (
  query: logging.LoggingQuery | undefined,
): SavedQueryLoggingQuery | undefined => {
  if (query === undefined || query.filter === undefined) return undefined;
  const summaryFields = query.summaryFields
    ?.filter((field) => field.field !== undefined)
    .map((field) => ({ field: field.field! }));
  return {
    filter: query.filter,
    summaryFieldStart: query.summaryFieldStart,
    summaryFieldEnd: query.summaryFieldEnd,
    summaryFields:
      summaryFields !== undefined && summaryFields.length > 0
        ? summaryFields
        : undefined,
  };
};

const opsAnalyticsQueryOf = (
  query: logging.OpsAnalyticsQuery | undefined,
): SavedQueryOpsAnalyticsQuery | undefined => {
  if (query?.sqlQueryText === undefined) return undefined;
  return { sqlQueryText: query.sqlQueryText };
};

const toLoggingQueryBody = (
  query: SavedQueryLoggingQuery | undefined,
): logging.LoggingQuery | undefined => {
  if (query === undefined) return undefined;
  return {
    filter: query.filter,
    summaryFieldStart: query.summaryFieldStart,
    summaryFieldEnd: query.summaryFieldEnd,
    summaryFields: query.summaryFields?.map((field) => ({
      field: field.field,
    })),
  };
};

const toOpsAnalyticsQueryBody = (
  query: SavedQueryOpsAnalyticsQuery | undefined,
): logging.OpsAnalyticsQuery | undefined => {
  if (query === undefined) return undefined;
  return { sqlQueryText: query.sqlQueryText };
};

const toAttrs = (
  query: logging.SavedQuery,
  project: string,
  location: string,
) => {
  const savedQueryId = savedQueryIdOf(query);
  const parsed = parseDescription(query.description);
  const parsedName = parseQueryName(query.name ?? "");
  const resolvedLocation = parsedName?.location ?? location;
  const resolvedProject = parsedName?.project ?? project;
  return {
    name:
      query.name ??
      (savedQueryId
        ? resourceName(resolvedProject, resolvedLocation, savedQueryId)
        : ""),
    savedQueryId,
    project: resolvedProject,
    location: resolvedLocation,
    displayName: query.displayName,
    visibility: query.visibility,
    loggingQuery: loggingQueryOf(query.loggingQuery),
    opsAnalyticsQuery: opsAnalyticsQueryOf(query.opsAnalyticsQuery),
    description: parsed.description,
    createTime: query.createTime,
    updateTime: query.updateTime,
  };
};

const getByName = (name: string) =>
  logging
    .getProjectsLocationsSavedQueries({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const SavedQueryProvider = () =>
  Provider.succeed(SavedQuery, {
    stables: ["name", "savedQueryId", "project", "location", "createTime"],

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
      if (!idChanged && !locationChanged) return undefined;
      return { action: "replace" as const, deleteFirst: false };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = olds?.location ?? output?.location ?? DEFAULT_LOCATION;
      const savedQueryId = yield* toId(
        id,
        olds?.savedQueryId,
        output?.savedQueryId,
      );
      const name =
        output?.name ?? resourceName(env.project, location, savedQueryId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, location);
      const { labels } = parseDescription(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* logging.listProjectsLocationsSavedQueries
          .pages({
            parent: `projects/${env.project}/locations/-`,
            pageSize: 1000,
          })
          .pipe(
            Stream.flatMap((page) =>
              Stream.fromIterable(page.savedQueries ?? []),
            ),
            Stream.filter((query) => hasOwnershipMarker(query.description)),
            Stream.map((query) => {
              const parsed = parseQueryName(query.name ?? "");
              return toAttrs(
                query,
                parsed?.project ?? env.project,
                parsed?.location ?? DEFAULT_LOCATION,
              );
            }),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = news.location ?? output?.location ?? DEFAULT_LOCATION;
      const savedQueryId = yield* toId(
        id,
        news.savedQueryId,
        output?.savedQueryId,
      );
      const name = resourceName(env.project, location, savedQueryId);
      const ownership = yield* createInternalLabels(id);
      const desiredDescription = encodeDescription(ownership, news.description);
      const desiredDisplayName = news.displayName ?? savedQueryId;
      const desiredVisibility = news.visibility ?? DEFAULT_VISIBILITY;
      const desiredLogging = toLoggingQueryBody(news.loggingQuery);
      const desiredOps = toOpsAnalyticsQueryBody(news.opsAnalyticsQuery);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* logging
          .createProjectsLocationsSavedQueries({
            parent: `projects/${env.project}/locations/${location}`,
            savedQueryId,
            body: {
              displayName: desiredDisplayName,
              visibility: desiredVisibility,
              description: desiredDescription,
              loggingQuery: desiredLogging,
              opsAnalyticsQuery: desiredOps,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new SavedQueryNotResolved({ name });
      }

      const displayNameChanged =
        (current.displayName ?? "") !== desiredDisplayName;
      const descriptionChanged =
        (current.description ?? "") !== desiredDescription;
      const visibilityChanged =
        (current.visibility ?? DEFAULT_VISIBILITY) !== desiredVisibility;
      const loggingChanged =
        news.loggingQuery !== undefined &&
        !jsonEqual(loggingQueryOf(current.loggingQuery), news.loggingQuery);
      const opsChanged =
        news.opsAnalyticsQuery !== undefined &&
        !jsonEqual(
          opsAnalyticsQueryOf(current.opsAnalyticsQuery),
          news.opsAnalyticsQuery,
        );

      const updateMask = [
        displayNameChanged ? "displayName" : undefined,
        descriptionChanged ? "description" : undefined,
        visibilityChanged ? "visibility" : undefined,
        loggingChanged ? "loggingQuery" : undefined,
        opsChanged ? "opsAnalyticsQuery" : undefined,
      ].filter((field): field is string => field !== undefined);

      if (updateMask.length > 0) {
        const body: logging.SavedQuery = {};
        if (displayNameChanged) body.displayName = desiredDisplayName;
        if (descriptionChanged) body.description = desiredDescription;
        if (visibilityChanged) body.visibility = desiredVisibility;
        if (loggingChanged) body.loggingQuery = desiredLogging;
        if (opsChanged) body.opsAnalyticsQuery = desiredOps;
        current = yield* logging.patchProjectsLocationsSavedQueries({
          name: current.name ?? name,
          updateMask: updateMask.join(","),
          body,
        });
      }

      return toAttrs(current, env.project, location);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* logging
        .deleteProjectsLocationsSavedQueries({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
