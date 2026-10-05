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
  billingAccountIdOf,
  billingAccountParent,
  encodeDescription,
  hasOwnershipMarker,
  jsonEqual,
  lastSegment,
  lookupProjectBillingAccountId,
  parseDescription,
  resolveBillingAccountId,
  toPhysicalId,
} from "./internal.ts";

export type BillingSavedQuerySummaryField = {
  /**
   * LogEntry field to include in the Logs Explorer summary line
   * (e.g. `resource.type` or `jsonPayload.name`).
   */
  field?: string;
};

export type BillingSavedQueryLoggingQuery = {
  /**
   * Advanced logs filter. Max 20000 characters.
   */
  filter: string;
  /**
   * Characters counted from the start of the string in the summary line.
   */
  summaryFieldStart?: number;
  /**
   * Characters counted from the end of the string in the summary line.
   */
  summaryFieldEnd?: number;
  /**
   * Summary fields shown for this query in Logs Explorer.
   */
  summaryFields?: BillingSavedQuerySummaryField[];
};

export type BillingSavedQueryOpsAnalyticsQuery = {
  /**
   * Log Analytics SQL query text. Used when non-empty even if
   * `queryBuilder` is also set.
   */
  sqlQueryText?: string;
};

export type BillingSavedQueryProps = {
  /**
   * Saved query id (the `{query}` segment of
   * `billingAccounts/{billingAccount}/locations/{location}/savedQueries/{query}`).
   * If omitted, a unique name is generated from the stack, stage, and
   * logical id. Limited to 100 characters: letters, digits, underscores,
   * hyphens, periods; first character must be alphanumeric. Immutable —
   * changing it replaces the query.
   */
  savedQueryId?: string;
  /**
   * Billing account id (`XXXXXX-XXXXXX-XXXXXX` or
   * `billingAccounts/{id}`). If omitted, Alchemy uses the billing
   * account linked to the current project. Immutable — changing it
   * replaces the query.
   */
  billingAccountId?: string;
  /**
   * Location of the saved query. Immutable after create — changing it
   * replaces the query.
   * @default "global"
   */
  location?: string;
  /**
   * User-specified title shown in Logs Explorer.
   */
  displayName: string;
  /**
   * Human-readable description. Saved queries have no labels field, so
   * Alchemy ownership is stored in a `[alchemy …]` prefix and stripped
   * from attributes.
   */
  description?: string;
  /**
   * Visibility / ownership of the query.
   * @default "PRIVATE"
   */
  visibility?: "PRIVATE" | "SHARED" | "VISIBILITY_UNSPECIFIED";
  /**
   * Logs Explorer query. At least one of `loggingQuery` or
   * `opsAnalyticsQuery` must be set.
   */
  loggingQuery?: BillingSavedQueryLoggingQuery;
  /**
   * Log Analytics SQL query. At least one of `loggingQuery` or
   * `opsAnalyticsQuery` must be set.
   */
  opsAnalyticsQuery?: BillingSavedQueryOpsAnalyticsQuery;
};

export type BillingSavedQuery = Resource<
  "GCP.Logging.BillingSavedQuery",
  BillingSavedQueryProps,
  {
    /** Full resource name `billingAccounts/{billingAccount}/locations/{location}/savedQueries/{savedQueryId}`. */
    name: string;
    /** Saved query id (last path segment). */
    savedQueryId: string;
    /** Billing account id. */
    billingAccountId: string;
    /** Location of the saved query. */
    location: string;
    /** User-specified title. */
    displayName: string;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Visibility / ownership. */
    visibility: string | undefined;
    /** Logs Explorer query, if set. */
    loggingQuery: BillingSavedQueryLoggingQuery | undefined;
    /** Log Analytics query, if set. */
    opsAnalyticsQuery: BillingSavedQueryOpsAnalyticsQuery | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Cloud Logging saved query owned by a billing account.
 *
 * Saved queries have no labels field, so Alchemy stamps ownership into
 * the description for `list` / nuke. `savedQueryId`, `location`, and
 * `billingAccountId` are identity — changing any replaces the query.
 * Display name, description, visibility, and query text update in place.
 *
 * ### Creating a Billing Saved Query
 * **Example:** Logs Explorer error query
 * ```typescript
 * const query = yield* GCP.Logging.BillingSavedQuery("Errors", {
 *   displayName: "billing errors",
 *   loggingQuery: { filter: "severity>=ERROR" },
 *   description: "error entries",
 * });
 * ```
 *
 * **Example:** Named shared query
 * ```typescript
 * const query = yield* GCP.Logging.BillingSavedQuery("Errors", {
 *   billingAccountId: "AAAAAA-BBBBBB-CCCCCC",
 *   savedQueryId: "billing-errors",
 *   displayName: "billing errors",
 *   visibility: "SHARED",
 *   loggingQuery: { filter: "severity>=ERROR" },
 * });
 * ```
 *
 * ### Updating a Billing Saved Query
 * **Example:** Change the filter and title
 * ```typescript
 * const query = yield* GCP.Logging.BillingSavedQuery("Errors", {
 *   displayName: "billing warnings",
 *   loggingQuery: { filter: "severity>=WARNING" },
 *   description: "warnings and errors",
 * });
 * ```
 *
 * @resource
 * @category Logging
 */
export const BillingSavedQuery = Resource<BillingSavedQuery>(
  "GCP.Logging.BillingSavedQuery",
);

export class BillingSavedQueryNotResolved extends Data.TaggedError(
  "GCP.Logging.BillingSavedQueryNotResolved",
)<{
  name: string;
}> {}

const resourceName = (
  billingAccountId: string,
  location: string,
  savedQueryId: string,
) =>
  `${billingAccountParent(billingAccountId)}/locations/${location}/savedQueries/${savedQueryId}`;

const parseQueryName = (name: string) => {
  const match = name.match(
    /^billingAccounts\/([^/]+)\/locations\/([^/]+)\/savedQueries\/([^/]+)$/,
  );
  if (!match) return undefined;
  return {
    billingAccountId: match[1]!,
    location: match[2]!,
    savedQueryId: match[3]!,
  };
};

const toLoggingQuery = (
  query: logging.LoggingQuery | undefined,
): BillingSavedQueryLoggingQuery | undefined => {
  if (query?.filter === undefined) return undefined;
  return {
    filter: query.filter,
    summaryFieldStart: query.summaryFieldStart,
    summaryFieldEnd: query.summaryFieldEnd,
    summaryFields: query.summaryFields,
  };
};

const toOpsQuery = (
  query: logging.OpsAnalyticsQuery | undefined,
): BillingSavedQueryOpsAnalyticsQuery | undefined => {
  if (query?.sqlQueryText === undefined) return undefined;
  return { sqlQueryText: query.sqlQueryText };
};

const toAttrs = (
  query: logging.SavedQuery,
  billingAccountId: string,
  location: string,
) => {
  const parsedName = parseQueryName(query.name ?? "");
  const savedQueryId =
    parsedName?.savedQueryId ?? lastSegment(query.name ?? "");
  const parsed = parseDescription(query.description);
  const account = parsedName?.billingAccountId ?? billingAccountId;
  const resolvedLocation = parsedName?.location ?? location;
  return {
    name:
      query.name ??
      (savedQueryId
        ? resourceName(account, resolvedLocation, savedQueryId)
        : ""),
    savedQueryId,
    billingAccountId: account,
    location: resolvedLocation,
    displayName: query.displayName ?? "",
    description: parsed.description,
    visibility: query.visibility,
    loggingQuery: toLoggingQuery(query.loggingQuery),
    opsAnalyticsQuery: toOpsQuery(query.opsAnalyticsQuery),
    createTime: query.createTime,
    updateTime: query.updateTime,
  };
};

const getByName = (name: string) =>
  logging
    .getBillingAccountsLocationsSavedQueries({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const toBody = (
  props: BillingSavedQueryProps,
  description: string,
): logging.SavedQuery => ({
  displayName: props.displayName,
  description,
  visibility: props.visibility ?? "PRIVATE",
  loggingQuery: props.loggingQuery
    ? {
        filter: props.loggingQuery.filter,
        summaryFieldStart: props.loggingQuery.summaryFieldStart,
        summaryFieldEnd: props.loggingQuery.summaryFieldEnd,
        summaryFields: props.loggingQuery.summaryFields,
      }
    : undefined,
  opsAnalyticsQuery: props.opsAnalyticsQuery
    ? { sqlQueryText: props.opsAnalyticsQuery.sqlQueryText }
    : undefined,
});

export const BillingSavedQueryProvider = () =>
  Provider.succeed(BillingSavedQuery, {
    stables: [
      "name",
      "savedQueryId",
      "billingAccountId",
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
      const previousAccount =
        olds?.billingAccountId ?? output?.billingAccountId;
      const accountChanged =
        previousAccount !== undefined &&
        news.billingAccountId !== undefined &&
        billingAccountIdOf(news.billingAccountId) !==
          billingAccountIdOf(previousAccount);
      if (!idChanged && !locationChanged && !accountChanged) return undefined;
      return { action: "replace" as const, deleteFirst: false };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const billingAccountId = yield* resolveBillingAccountId(
        olds?.billingAccountId,
        output?.billingAccountId,
      );
      const location = olds?.location ?? output?.location ?? DEFAULT_LOCATION;
      const savedQueryId = yield* toPhysicalId(
        id,
        olds?.savedQueryId,
        output?.savedQueryId,
        "q",
      );
      const name =
        output?.name ?? resourceName(billingAccountId, location, savedQueryId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, billingAccountId, location);
      const { labels } = parseDescription(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const billingAccountId = yield* lookupProjectBillingAccountId(
          env.project,
        );
        if (billingAccountId === undefined) return [];
        return yield* logging.listBillingAccountsLocationsSavedQueries
          .pages({
            parent: `${billingAccountParent(billingAccountId)}/locations/-`,
            pageSize: 1000,
          })
          .pipe(
            Stream.flatMap((page) =>
              Stream.fromIterable(page.savedQueries ?? []),
            ),
            Stream.filter((query) => hasOwnershipMarker(query.description)),
            Stream.map((query) =>
              toAttrs(query, billingAccountId, DEFAULT_LOCATION),
            ),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
            Effect.catchTag("NotFound", () =>
              Effect.succeed([] as BillingSavedQuery["Attributes"][]),
            ),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const billingAccountId = yield* resolveBillingAccountId(
        news.billingAccountId,
        output?.billingAccountId,
      );
      const location = news.location ?? output?.location ?? DEFAULT_LOCATION;
      const savedQueryId = yield* toPhysicalId(
        id,
        news.savedQueryId,
        output?.savedQueryId,
        "q",
      );
      const name = resourceName(billingAccountId, location, savedQueryId);
      const ownership = yield* createInternalLabels(id);
      const desiredDescription = encodeDescription(ownership, news.description);
      const desiredVisibility = news.visibility ?? "PRIVATE";

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* logging
          .createBillingAccountsLocationsSavedQueries({
            parent: `${billingAccountParent(billingAccountId)}/locations/${location}`,
            savedQueryId,
            body: toBody(news, desiredDescription),
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new BillingSavedQueryNotResolved({ name });
      }

      const descriptionChanged =
        (current.description ?? "") !== desiredDescription;
      const displayNameChanged =
        (current.displayName ?? "") !== news.displayName;
      const visibilityChanged =
        (current.visibility ?? "PRIVATE") !== desiredVisibility;
      const loggingChanged =
        news.loggingQuery !== undefined &&
        !jsonEqual(toLoggingQuery(current.loggingQuery), news.loggingQuery);
      const opsChanged =
        news.opsAnalyticsQuery !== undefined &&
        !jsonEqual(
          toOpsQuery(current.opsAnalyticsQuery),
          news.opsAnalyticsQuery,
        );

      const updateMask = [
        descriptionChanged ? "description" : undefined,
        displayNameChanged ? "displayName" : undefined,
        visibilityChanged ? "visibility" : undefined,
        loggingChanged ? "loggingQuery" : undefined,
        opsChanged ? "opsAnalyticsQuery" : undefined,
      ].filter((field): field is string => field !== undefined);

      if (updateMask.length > 0) {
        current = yield* logging.patchBillingAccountsLocationsSavedQueries({
          name: current.name ?? name,
          updateMask: updateMask.join(","),
          body: toBody(news, desiredDescription),
        });
      }

      return toAttrs(current, billingAccountId, location);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* logging
        .deleteBillingAccountsLocationsSavedQueries({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
