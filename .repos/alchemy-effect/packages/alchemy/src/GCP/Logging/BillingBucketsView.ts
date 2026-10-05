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
  lastSegment,
  lookupProjectBillingAccountId,
  parseDescription,
  resolveBillingAccountId,
  toPhysicalId,
} from "./internal.ts";

export type BillingBucketsViewProps = {
  /**
   * View id (the `{view}` segment of
   * `billingAccounts/{billingAccount}/locations/{location}/buckets/{bucket}/views/{view}`).
   * If omitted, a unique name is generated from the stack, stage, and
   * logical id. Limited to 100 characters: letters, digits, underscores,
   * and hyphens. Immutable — changing it replaces the view.
   */
  viewId?: string;
  /**
   * Bucket id that owns this view. Immutable — changing it replaces the
   * view.
   */
  bucketId: string;
  /**
   * Billing account id (`XXXXXX-XXXXXX-XXXXXX` or
   * `billingAccounts/{id}`). If omitted, Alchemy uses the billing
   * account linked to the current project. Immutable — changing it
   * replaces the view.
   */
  billingAccountId?: string;
  /**
   * Location of the parent bucket. Immutable — changing it replaces the
   * view.
   * @default "global"
   */
  location?: string;
  /**
   * Filter that restricts which log entries in the bucket are visible.
   * Must be a conjunction of `SOURCE()`, `resource.type`, and `LOG_ID()`.
   */
  filter?: string;
  /**
   * Human-readable description. Log views have no labels field, so
   * Alchemy ownership is stored in a `[alchemy …]` prefix and stripped
   * from attributes.
   */
  description?: string;
};

export type BillingBucketsView = Resource<
  "GCP.Logging.BillingBucketsView",
  BillingBucketsViewProps,
  {
    /** Full resource name `billingAccounts/{billingAccount}/locations/{location}/buckets/{bucket}/views/{view}`. */
    name: string;
    /** View id (last path segment). */
    viewId: string;
    /** Parent bucket id. */
    bucketId: string;
    /** Billing account id. */
    billingAccountId: string;
    /** Location of the parent bucket. */
    location: string;
    /** View filter, if set. */
    filter: string | undefined;
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
 * A Cloud Logging view over log entries in a billing-account log bucket.
 *
 * A bucket may contain a maximum of 30 views. Log views have no labels
 * field, so Alchemy stamps ownership into the description for `list` /
 * nuke. `viewId`, `bucketId`, `location`, and `billingAccountId` are
 * identity — changing any replaces the view. Filter and description
 * update in place.
 *
 * ### Creating a Billing Bucket View
 * **Example:** View of Compute Engine logs
 * ```typescript
 * const view = yield* GCP.Logging.BillingBucketsView("Gce", {
 *   bucketId: bucket.bucketId,
 *   filter: 'resource.type = "gce_instance"',
 *   description: "compute logs",
 * });
 * ```
 *
 * **Example:** Named view on an explicit billing account
 * ```typescript
 * const view = yield* GCP.Logging.BillingBucketsView("Gce", {
 *   billingAccountId: "AAAAAA-BBBBBB-CCCCCC",
 *   location: "global",
 *   bucketId: "app-logs",
 *   viewId: "gce-logs",
 *   filter: 'resource.type = "gce_instance"',
 * });
 * ```
 *
 * ### Updating a Billing Bucket View
 * **Example:** Change the filter
 * ```typescript
 * const view = yield* GCP.Logging.BillingBucketsView("Gce", {
 *   bucketId: bucket.bucketId,
 *   location: "global",
 *   filter: 'resource.type = "gce_instance" AND severity>=ERROR',
 *   description: "compute errors",
 * });
 * ```
 *
 * @resource
 * @category Logging
 */
export const BillingBucketsView = Resource<BillingBucketsView>(
  "GCP.Logging.BillingBucketsView",
);

export class BillingBucketsViewNotResolved extends Data.TaggedError(
  "GCP.Logging.BillingBucketsViewNotResolved",
)<{
  name: string;
}> {}

const resourceName = (
  billingAccountId: string,
  location: string,
  bucketId: string,
  viewId: string,
) =>
  `${billingAccountParent(billingAccountId)}/locations/${location}/buckets/${bucketId}/views/${viewId}`;

const parseViewName = (name: string) => {
  const match = name.match(
    /^billingAccounts\/([^/]+)\/locations\/([^/]+)\/buckets\/([^/]+)\/views\/([^/]+)$/,
  );
  if (!match) return undefined;
  return {
    billingAccountId: match[1]!,
    location: match[2]!,
    bucketId: match[3]!,
    viewId: match[4]!,
  };
};

const toAttrs = (
  view: logging.LogView,
  billingAccountId: string,
  location: string,
  bucketId: string,
) => {
  const parsedName = parseViewName(view.name ?? "");
  const viewId = parsedName?.viewId ?? lastSegment(view.name ?? "");
  const parsed = parseDescription(view.description);
  const account = parsedName?.billingAccountId ?? billingAccountId;
  const resolvedLocation = parsedName?.location ?? location;
  const resolvedBucket = parsedName?.bucketId ?? bucketId;
  return {
    name:
      view.name ??
      (viewId
        ? resourceName(account, resolvedLocation, resolvedBucket, viewId)
        : ""),
    viewId,
    bucketId: resolvedBucket,
    billingAccountId: account,
    location: resolvedLocation,
    filter: view.filter,
    description: parsed.description,
    createTime: view.createTime,
    updateTime: view.updateTime,
  };
};

const getByName = (name: string) =>
  logging
    .getBillingAccountsLocationsBucketsViews({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const BillingBucketsViewProvider = () =>
  Provider.succeed(BillingBucketsView, {
    stables: [
      "name",
      "viewId",
      "bucketId",
      "billingAccountId",
      "location",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.viewId ?? output?.viewId;
      const idChanged =
        previousId !== undefined &&
        news.viewId !== undefined &&
        news.viewId !== previousId;
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
      return { action: "replace" as const, deleteFirst: false };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const billingAccountId = yield* resolveBillingAccountId(
        olds?.billingAccountId,
        output?.billingAccountId,
      );
      const location = olds?.location ?? output?.location ?? DEFAULT_LOCATION;
      const bucketId = olds?.bucketId ?? output?.bucketId ?? "";
      const viewId = yield* toPhysicalId(id, olds?.viewId, output?.viewId, "v");
      const name =
        output?.name ??
        resourceName(billingAccountId, location, bucketId, viewId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
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
        const listed: BillingBucketsView["Attributes"][] = [];
        for (const bucket of buckets) {
          if (!bucket.name) continue;
          const views = yield* logging.listBillingAccountsLocationsBucketsViews
            .pages({ parent: bucket.name, pageSize: 1000 })
            .pipe(
              Stream.flatMap((page) => Stream.fromIterable(page.views ?? [])),
              Stream.filter((view) => hasOwnershipMarker(view.description)),
              Stream.map((view) =>
                toAttrs(
                  view,
                  billingAccountId,
                  DEFAULT_LOCATION,
                  lastSegment(bucket.name ?? ""),
                ),
              ),
              Stream.runCollect,
              Effect.map((chunk) => Array.from(chunk)),
              Effect.catchTag("NotFound", () =>
                Effect.succeed([] as BillingBucketsView["Attributes"][]),
              ),
            );
          listed.push(...views);
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
      const viewId = yield* toPhysicalId(id, news.viewId, output?.viewId, "v");
      const name = resourceName(billingAccountId, location, bucketId, viewId);
      const parent = `${billingAccountParent(billingAccountId)}/locations/${location}/buckets/${bucketId}`;
      const ownership = yield* createInternalLabels(id);
      const desiredDescription = encodeDescription(ownership, news.description);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* logging
          .createBillingAccountsLocationsBucketsViews({
            parent,
            viewId,
            body: {
              filter: news.filter,
              description: desiredDescription,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new BillingBucketsViewNotResolved({ name });
      }

      const filterChanged = (current.filter ?? "") !== (news.filter ?? "");
      const descriptionChanged =
        (current.description ?? "") !== desiredDescription;
      const updateMask = [
        filterChanged ? "filter" : undefined,
        descriptionChanged ? "description" : undefined,
      ].filter((field): field is string => field !== undefined);

      if (updateMask.length > 0) {
        current = yield* logging.patchBillingAccountsLocationsBucketsViews({
          name: current.name ?? name,
          updateMask: updateMask.join(","),
          body: {
            filter: news.filter ?? "",
            description: desiredDescription,
          },
        });
      }

      return toAttrs(current, billingAccountId, location, bucketId);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* logging
        .deleteBillingAccountsLocationsBucketsViews({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
