import * as logging from "@distilled.cloud/gcp/logging_v2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
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
  lastSegment,
  lookupProjectBillingAccountId,
  parseDescription,
  resolveBillingAccountId,
  toLinkId,
} from "./internal.ts";
import { waitForDeleteOperation, waitForOperation } from "./operations.ts";

export type BillingBucketsLinkProps = {
  /**
   * Link id (the `{link}` segment of
   * `billingAccounts/{billingAccount}/locations/{location}/buckets/{bucket}/links/{link}`).
   * If omitted, a unique name is generated from the stack, stage, and
   * logical id. Must be alphanumeric plus underscores (BigQuery dataset
   * naming). Immutable — changing it replaces the link.
   */
  linkId?: string;
  /**
   * Analytics-enabled bucket id that owns this link. A bucket may have
   * only one link. Immutable — changing it replaces the link.
   */
  bucketId: string;
  /**
   * Billing account id (`XXXXXX-XXXXXX-XXXXXX` or
   * `billingAccounts/{id}`). If omitted, Alchemy uses the billing
   * account linked to the current project. Immutable — changing it
   * replaces the link.
   */
  billingAccountId?: string;
  /**
   * Location of the parent bucket. Immutable — changing it replaces the
   * link.
   * @default "global"
   */
  location?: string;
  /**
   * Human-readable description (max 8000 characters). Links have no
   * labels or update API, so Alchemy ownership is stored in a
   * `[alchemy …]` prefix at create time and stripped from attributes.
   */
  description?: string;
};

export type BillingBucketsLink = Resource<
  "GCP.Logging.BillingBucketsLink",
  BillingBucketsLinkProps,
  {
    /** Full resource name `billingAccounts/{billingAccount}/locations/{location}/buckets/{bucket}/links/{link}`. */
    name: string;
    /** Link id (last path segment). */
    linkId: string;
    /** Parent bucket id. */
    bucketId: string;
    /** Billing account id. */
    billingAccountId: string;
    /** Location of the parent bucket. */
    location: string;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Linked BigQuery dataset id, if reported. */
    bigqueryDatasetId: string | undefined;
    /** Link lifecycle (`ACTIVE`, `CREATING`, …). */
    lifecycleState: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A BigQuery dataset link for a billing-account log bucket.
 *
 * Creating a link asynchronously provisions a BigQuery dataset (and views
 * for each log view) so Log Analytics queries can run against the bucket.
 * A bucket may currently contain only one link. Links have no update API
 * — they are existence-only after create. Alchemy stamps ownership into
 * the description at create time for `list` / nuke. `linkId`, `bucketId`,
 * `location`, and `billingAccountId` are identity.
 *
 * ### Creating a Billing Bucket Link
 * **Example:** Link an analytics-enabled bucket
 * ```typescript
 * const bucket = yield* GCP.Logging.BillingBucket("AppLogs", {
 *   analyticsEnabled: true,
 * });
 * const link = yield* GCP.Logging.BillingBucketsLink("Analytics", {
 *   bucketId: bucket.bucketId,
 *   location: bucket.location,
 *   billingAccountId: bucket.billingAccountId,
 *   description: "log analytics",
 * });
 * ```
 *
 * **Example:** Named link
 * ```typescript
 * const link = yield* GCP.Logging.BillingBucketsLink("Analytics", {
 *   billingAccountId: "AAAAAA-BBBBBB-CCCCCC",
 *   location: "global",
 *   bucketId: "app-logs",
 *   linkId: "app_logs_link",
 * });
 * ```
 *
 * @resource
 * @category Logging
 */
export const BillingBucketsLink = Resource<BillingBucketsLink>(
  "GCP.Logging.BillingBucketsLink",
);

export class BillingBucketsLinkNotResolved extends Data.TaggedError(
  "GCP.Logging.BillingBucketsLinkNotResolved",
)<{
  name: string;
}> {}

const resourceName = (
  billingAccountId: string,
  location: string,
  bucketId: string,
  linkId: string,
) =>
  `${billingAccountParent(billingAccountId)}/locations/${location}/buckets/${bucketId}/links/${linkId}`;

const parseLinkName = (name: string) => {
  const match = name.match(
    /^billingAccounts\/([^/]+)\/locations\/([^/]+)\/buckets\/([^/]+)\/links\/([^/]+)$/,
  );
  if (!match) return undefined;
  return {
    billingAccountId: match[1]!,
    location: match[2]!,
    bucketId: match[3]!,
    linkId: match[4]!,
  };
};

const isDeleted = (link: logging.Link | undefined): link is undefined =>
  link === undefined || link.lifecycleState === "DELETE_REQUESTED";

const isPending = (state: string | undefined) =>
  state === "CREATING" || state === "UPDATING";

const toAttrs = (
  link: logging.Link,
  billingAccountId: string,
  location: string,
  bucketId: string,
) => {
  const parsedName = parseLinkName(link.name ?? "");
  const linkId = parsedName?.linkId ?? lastSegment(link.name ?? "");
  const parsed = parseDescription(link.description);
  const account = parsedName?.billingAccountId ?? billingAccountId;
  const resolvedLocation = parsedName?.location ?? location;
  const resolvedBucket = parsedName?.bucketId ?? bucketId;
  return {
    name:
      link.name ??
      (linkId
        ? resourceName(account, resolvedLocation, resolvedBucket, linkId)
        : ""),
    linkId,
    bucketId: resolvedBucket,
    billingAccountId: account,
    location: resolvedLocation,
    description: parsed.description,
    bigqueryDatasetId: link.bigqueryDataset?.datasetId,
    lifecycleState: link.lifecycleState,
    createTime: link.createTime,
  };
};

const getByName = (name: string) =>
  logging
    .getBillingAccountsLocationsBucketsLinks({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitUntilActive = (name: string) =>
  Effect.gen(function* () {
    const link = yield* getByName(name);
    if (link === undefined || isDeleted(link)) {
      return yield* new BillingBucketsLinkNotResolved({ name });
    }
    if (link.lifecycleState === "FAILED") {
      return yield* new BillingBucketsLinkNotResolved({ name });
    }
    if (isPending(link.lifecycleState)) {
      return yield* new BillingBucketsLinkNotResolved({ name });
    }
    return link;
  }).pipe(
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Logging.BillingBucketsLinkNotResolved",
      times: 10,
      schedule: Schedule.spaced("3 seconds"),
    }),
  );

const waitUntilDeleted = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((link) =>
      isDeleted(link)
        ? Effect.void
        : Effect.fail(new BillingBucketsLinkNotResolved({ name })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Logging.BillingBucketsLinkNotResolved",
      times: 10,
      schedule: Schedule.spaced("3 seconds"),
    }),
  );

export const BillingBucketsLinkProvider = () =>
  Provider.succeed(BillingBucketsLink, {
    stables: [
      "name",
      "linkId",
      "bucketId",
      "billingAccountId",
      "location",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.linkId ?? output?.linkId;
      const idChanged =
        previousId !== undefined &&
        news.linkId !== undefined &&
        news.linkId !== previousId;
      const previousBucket = olds?.bucketId ?? output?.bucketId;
      const bucketChanged =
        previousBucket !== undefined && news.bucketId !== previousBucket;
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
      if (!idChanged && !bucketChanged && !locationChanged && !accountChanged) {
        return undefined;
      }
      return { action: "replace" as const, deleteFirst: true };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const billingAccountId = yield* resolveBillingAccountId(
        olds?.billingAccountId,
        output?.billingAccountId,
      );
      const location = olds?.location ?? output?.location ?? DEFAULT_LOCATION;
      const bucketId = olds?.bucketId ?? output?.bucketId ?? "";
      const linkId = yield* toLinkId(id, olds?.linkId, output?.linkId);
      const name =
        output?.name ??
        resourceName(billingAccountId, location, bucketId, linkId);
      const existing = yield* getByName(name);
      if (isDeleted(existing)) return undefined;
      const attrs = toAttrs(existing, billingAccountId, location, bucketId);
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
        const buckets = yield* logging.listBillingAccountsLocationsBuckets
          .pages({
            parent: `${billingAccountParent(billingAccountId)}/locations/-`,
            pageSize: 1000,
          })
          .pipe(
            Stream.flatMap((page) => Stream.fromIterable(page.buckets ?? [])),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
            Effect.catchTag("NotFound", () =>
              Effect.succeed([] as logging.LogBucket[]),
            ),
          );
        const listed: BillingBucketsLink["Attributes"][] = [];
        for (const bucket of buckets) {
          if (!bucket.name) continue;
          const links = yield* logging.listBillingAccountsLocationsBucketsLinks
            .pages({ parent: bucket.name, pageSize: 1000 })
            .pipe(
              Stream.flatMap((page) => Stream.fromIterable(page.links ?? [])),
              Stream.filter(
                (link) =>
                  !isDeleted(link) && hasOwnershipMarker(link.description),
              ),
              Stream.map((link) =>
                toAttrs(
                  link,
                  billingAccountId,
                  DEFAULT_LOCATION,
                  lastSegment(bucket.name ?? ""),
                ),
              ),
              Stream.runCollect,
              Effect.map((chunk) => Array.from(chunk)),
              Effect.catchTag("NotFound", () =>
                Effect.succeed([] as BillingBucketsLink["Attributes"][]),
              ),
            );
          listed.push(...links);
        }
        return listed;
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const billingAccountId = yield* resolveBillingAccountId(
        news.billingAccountId,
        output?.billingAccountId,
      );
      const location = news.location ?? output?.location ?? DEFAULT_LOCATION;
      const bucketId = news.bucketId;
      const linkId = yield* toLinkId(id, news.linkId, output?.linkId);
      const name = resourceName(billingAccountId, location, bucketId, linkId);
      const parent = `${billingAccountParent(billingAccountId)}/locations/${location}/buckets/${bucketId}`;
      const ownership = yield* createInternalLabels(id);
      const desiredDescription = encodeDescription(ownership, news.description);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const operation = yield* logging
          .createBillingAccountsLocationsBucketsLinks({
            parent,
            linkId,
            body: { description: desiredDescription },
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              Effect.succeed<logging.Operation>({ done: true }),
            ),
          );
        if (operation.done !== true || operation.name) {
          yield* waitForOperation(operation);
        }
        current = yield* waitUntilActive(name);
      } else if (isPending(current.lifecycleState)) {
        current = yield* waitUntilActive(current.name ?? name);
      }

      if (isDeleted(current)) {
        return yield* new BillingBucketsLinkNotResolved({ name });
      }

      return toAttrs(current, billingAccountId, location, bucketId);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (output.lifecycleState === "DELETE_REQUESTED") return;
      const operation = yield* logging
        .deleteBillingAccountsLocationsBucketsLinks({ name: output.name })
        .pipe(
          Effect.catchTag("NotFound", () =>
            Effect.succeed<logging.Operation>({ done: true }),
          ),
        );
      if (operation.done !== true || operation.name) {
        yield* waitForDeleteOperation(operation);
      }
      yield* waitUntilDeleted(output.name);
    }),
  });
