import * as logging from "@distilled.cloud/gcp/logging_v2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels, hasAlchemyLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  DEFAULT_LOCATION,
  encodeDescription,
  hasOwnershipMarker,
  lastSegment,
  organizationIdOf,
  parseDescription,
  resolveOrganization,
  toPhysicalId,
  tryResolveOrganization,
} from "./internal.ts";

export type OrganizationSavedQueryLoggingQuery = {
  /**
   * Advanced Logging Query Language filter (max 20000 characters).
   */
  filter: string;
  /**
   * Summary field start character offset.
   */
  summaryFieldStart?: number;
  /**
   * Summary field end character offset.
   */
  summaryFieldEnd?: number;
  /**
   * LogEntry fields to include in the Logs Explorer summary line.
   */
  summaryFields?: string[];
};

export type OrganizationSavedQueryProps = {
  /**
   * Saved query id (the last segment of the resource name). If omitted,
   * a unique name is generated from the stack, stage, and logical id.
   * Limited to 100 characters: letters, digits, underscores, hyphens,
   * periods; first character must be alphanumeric. Immutable — changing
   * it replaces the query.
   */
  savedQueryId?: string;
  /**
   * Parent organization (`organizations/{organization}` or the numeric
   * id). Defaults to the project ancestor organization. Immutable —
   * changing it replaces the query.
   */
  organization?: string;
  /**
   * Location of the saved query. Immutable after create — changing it
   * replaces the query.
   * @default "global"
   */
  location?: string;
  /**
   * User-visible title. If omitted, the saved query id is used.
   */
  displayName?: string;
  /**
   * Visibility of the query (`PRIVATE` or `SHARED`).
   * @default "PRIVATE"
   */
  visibility?: "PRIVATE" | "SHARED" | "VISIBILITY_UNSPECIFIED";
  /**
   * Logs Explorer query. At least one of `loggingQuery` or
   * `opsAnalyticsQuery` is required.
   */
  loggingQuery?: OrganizationSavedQueryLoggingQuery;
  /**
   * Log Analytics SQL query text. Used when `loggingQuery` is omitted.
   */
  sqlQueryText?: string;
  /**
   * Human-readable description. Saved queries have no labels field, so
   * Alchemy ownership is stored in a `[alchemy …]` prefix and stripped
   * from attributes.
   */
  description?: string;
};

export type OrganizationSavedQuery = Resource<
  "GCP.Logging.OrganizationSavedQuery",
  OrganizationSavedQueryProps,
  {
    /** Full resource name `organizations/{organization}/locations/{location}/savedQueries/{query}`. */
    name: string;
    /** Saved query id (last path segment). */
    savedQueryId: string;
    /** Organization resource name. */
    organization: string;
    /** Organization id. */
    organizationId: string;
    /** Project id of the deploying stack. */
    project: string;
    /** Location of the saved query. */
    location: string;
    /** User-visible title. */
    displayName: string | undefined;
    /** Visibility (`PRIVATE` or `SHARED`). */
    visibility: string | undefined;
    /** Logs Explorer filter, if set. */
    loggingQuery: OrganizationSavedQueryLoggingQuery | undefined;
    /** Log Analytics SQL, if set. */
    sqlQueryText: string | undefined;
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
 * A Cloud Logging saved query on an organization.
 *
 * Saved queries have no labels field, so Alchemy stamps ownership into
 * the description for `list` / nuke. `savedQueryId`, organization, and
 * location are identity — changing any replaces the query.
 *
 * ### Creating an Organization Saved Query
 * **Example:** Generated name
 * ```typescript
 * const query = yield* GCP.Logging.OrganizationSavedQuery("Errors", {
 *   displayName: "org errors",
 *   loggingQuery: { filter: "severity>=ERROR" },
 *   description: "organization errors",
 * });
 * ```
 *
 * **Example:** Named shared query
 * ```typescript
 * const query = yield* GCP.Logging.OrganizationSavedQuery("Errors", {
 *   savedQueryId: "org-errors",
 *   visibility: "SHARED",
 *   loggingQuery: { filter: "severity>=ERROR" },
 * });
 * ```
 *
 * ### Updating an Organization Saved Query
 * **Example:** Change the filter and title
 * ```typescript
 * const query = yield* GCP.Logging.OrganizationSavedQuery("Errors", {
 *   displayName: "org warnings",
 *   loggingQuery: { filter: "severity>=WARNING" },
 *   description: "warnings and errors",
 * });
 * ```
 *
 * @resource
 * @category Logging
 */
export const OrganizationSavedQuery = Resource<OrganizationSavedQuery>(
  "GCP.Logging.OrganizationSavedQuery",
);

export class OrganizationSavedQueryNotResolved extends Data.TaggedError(
  "GCP.Logging.OrganizationSavedQueryNotResolved",
)<{
  name: string;
}> {}

const resourceName = (
  organization: string,
  location: string,
  savedQueryId: string,
) => `${organization}/locations/${location}/savedQueries/${savedQueryId}`;

const parseQueryName = (name: string) => {
  const match = name.match(
    /^(organizations\/[^/]+)\/locations\/([^/]+)\/savedQueries\/([^/]+)$/,
  );
  if (!match) return undefined;
  return {
    organization: match[1]!,
    location: match[2]!,
    savedQueryId: match[3]!,
  };
};

const toLoggingQuery = (
  query: logging.LoggingQuery | undefined,
): OrganizationSavedQueryLoggingQuery | undefined => {
  if (query === undefined) return undefined;
  return {
    filter: query.filter ?? "",
    summaryFieldStart: query.summaryFieldStart,
    summaryFieldEnd: query.summaryFieldEnd,
    summaryFields: query.summaryFields
      ?.map((field) => field.field)
      .filter((field): field is string => field !== undefined),
  };
};

const fromLoggingQuery = (
  query: OrganizationSavedQueryLoggingQuery | undefined,
): logging.LoggingQuery | undefined => {
  if (query === undefined) return undefined;
  return {
    filter: query.filter,
    summaryFieldStart: query.summaryFieldStart,
    summaryFieldEnd: query.summaryFieldEnd,
    summaryFields: query.summaryFields?.map((field) => ({ field })),
  };
};

const toAttrs = (
  query: logging.SavedQuery,
  organization: string,
  project: string,
  location: string,
) => {
  const parsed = parseQueryName(query.name ?? "");
  const savedQueryId = parsed?.savedQueryId ?? lastSegment(query.name ?? "");
  const description = parseDescription(query.description);
  const resolvedOrg = parsed?.organization ?? organization;
  const resolvedLocation = parsed?.location ?? location;
  return {
    name:
      query.name ??
      (savedQueryId
        ? resourceName(resolvedOrg, resolvedLocation, savedQueryId)
        : ""),
    savedQueryId,
    organization: resolvedOrg,
    organizationId: organizationIdOf(resolvedOrg),
    project,
    location: resolvedLocation,
    displayName: query.displayName,
    visibility: query.visibility,
    loggingQuery: toLoggingQuery(query.loggingQuery),
    sqlQueryText: query.opsAnalyticsQuery?.sqlQueryText,
    description: description.description,
    createTime: query.createTime,
    updateTime: query.updateTime,
  };
};

const getByName = (name: string) =>
  logging
    .getOrganizationsLocationsSavedQueries({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const toCreateBody = (
  props: OrganizationSavedQueryProps,
  savedQueryId: string,
  description: string,
): logging.SavedQuery => {
  const displayName = props.displayName ?? savedQueryId;
  const visibility = props.visibility ?? "PRIVATE";
  const loggingQuery =
    props.loggingQuery ??
    (props.sqlQueryText === undefined
      ? { filter: "severity>=DEFAULT" }
      : undefined);
  return {
    displayName,
    visibility,
    description,
    loggingQuery: fromLoggingQuery(loggingQuery),
    opsAnalyticsQuery:
      props.sqlQueryText !== undefined
        ? { sqlQueryText: props.sqlQueryText }
        : undefined,
  };
};

export const OrganizationSavedQueryProvider = () =>
  Provider.succeed(OrganizationSavedQuery, {
    stables: [
      "name",
      "savedQueryId",
      "organization",
      "organizationId",
      "project",
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
      const previousOrg = olds?.organization ?? output?.organization;
      const orgChanged =
        previousOrg !== undefined &&
        news.organization !== undefined &&
        news.organization !== previousOrg;
      if (!idChanged && !locationChanged && !orgChanged) return undefined;
      return { action: "replace" as const, deleteFirst: false };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const organization = yield* resolveOrganization(
        olds?.organization ?? output?.organization,
        output?.organization,
      );
      const location = olds?.location ?? output?.location ?? DEFAULT_LOCATION;
      const savedQueryId = yield* toPhysicalId(
        id,
        olds?.savedQueryId,
        output?.savedQueryId,
        "q",
      );
      const name =
        output?.name ?? resourceName(organization, location, savedQueryId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, organization, env.project, location);
      const { labels } = parseDescription(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const organization = yield* tryResolveOrganization();
        if (organization === undefined) return [];
        return yield* logging.listOrganizationsLocationsSavedQueries
          .pages({
            parent: `${organization}/locations/-`,
            pageSize: 1000,
          })
          .pipe(
            Stream.flatMap((page) =>
              Stream.fromIterable(page.savedQueries ?? []),
            ),
            Stream.filter((query) => hasOwnershipMarker(query.description)),
            Stream.map((query) =>
              toAttrs(query, organization, env.project, DEFAULT_LOCATION),
            ),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
            Effect.catchTag("NotFound", () => Effect.succeed([])),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const organization = yield* resolveOrganization(
        news.organization,
        output?.organization,
      );
      const location = news.location ?? output?.location ?? DEFAULT_LOCATION;
      const savedQueryId = yield* toPhysicalId(
        id,
        news.savedQueryId,
        output?.savedQueryId,
        "q",
      );
      const name = resourceName(organization, location, savedQueryId);
      const ownership = yield* createInternalLabels(id);
      const desiredDescription = encodeDescription(ownership, news.description);
      const desiredDisplayName = news.displayName ?? savedQueryId;
      const desiredVisibility = news.visibility ?? "PRIVATE";
      const desiredLogging =
        news.loggingQuery ??
        (news.sqlQueryText === undefined
          ? { filter: "severity>=DEFAULT" }
          : undefined);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* logging
          .createOrganizationsLocationsSavedQueries({
            parent: `${organization}/locations/${location}`,
            savedQueryId,
            body: toCreateBody(news, savedQueryId, desiredDescription),
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new OrganizationSavedQueryNotResolved({ name });
      }

      const descriptionChanged =
        (current.description ?? "") !== desiredDescription;
      const displayNameChanged =
        (current.displayName ?? "") !== desiredDisplayName;
      const visibilityChanged =
        (current.visibility ?? "PRIVATE") !== desiredVisibility;
      const filterChanged =
        (current.loggingQuery?.filter ?? "") !== (desiredLogging?.filter ?? "");
      const sqlChanged =
        (current.opsAnalyticsQuery?.sqlQueryText ?? "") !==
        (news.sqlQueryText ?? "");

      const updateMask = [
        descriptionChanged ? "description" : undefined,
        displayNameChanged ? "displayName" : undefined,
        visibilityChanged ? "visibility" : undefined,
        filterChanged ? "loggingQuery" : undefined,
        sqlChanged ? "opsAnalyticsQuery" : undefined,
      ].filter((field): field is string => field !== undefined);

      if (updateMask.length > 0) {
        current = yield* logging.patchOrganizationsLocationsSavedQueries({
          name: current.name ?? name,
          updateMask: updateMask.join(","),
          body: {
            description: desiredDescription,
            displayName: desiredDisplayName,
            visibility: desiredVisibility,
            loggingQuery: fromLoggingQuery(desiredLogging),
            opsAnalyticsQuery:
              news.sqlQueryText !== undefined
                ? { sqlQueryText: news.sqlQueryText }
                : undefined,
          },
        });
      }

      return toAttrs(current, organization, env.project, location);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* logging
        .deleteOrganizationsLocationsSavedQueries({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
