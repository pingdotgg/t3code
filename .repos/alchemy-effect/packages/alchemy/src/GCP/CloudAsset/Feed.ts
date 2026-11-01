import * as cloudasset from "@distilled.cloud/gcp/cloudasset_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  encodeDescription,
  grantCloudAssetPublisher,
  hasOwnershipMarker,
  lastSegment,
  listFeeds,
  NO_OP_EXPRESSION,
  ownedByAlchemy,
  parentOf,
  parseDescription,
  replaceOn,
  scopeParent,
  sameJson,
  sameStringList,
  sameText,
  toPhysicalId,
  updateMaskOf,
} from "./internal.ts";

export type FeedContentType = cloudasset.FeedContentTypeEnum | (string & {});

export type FeedCondition = {
  /**
   * CEL expression evaluated against a `TemporalAsset` named
   * `temporal_asset`. Example: `temporal_asset.deleted == true`.
   */
  expression?: string;
  /**
   * Short title shown in UIs that edit the expression.
   */
  title?: string;
  /**
   * Longer description of the expression. Feeds have no labels field, so
   * Alchemy ownership is stored in a `[alchemy …]` prefix here and
   * stripped from attributes.
   */
  description?: string;
  /**
   * Source location of the expression for error reporting.
   */
  location?: string;
};

export type FeedProps = {
  /**
   * Feed id (the `{feed}` segment of
   * `projects/{project}/feeds/{feed}`). If omitted, a unique RFC1035
   * name is generated. Immutable — changing it replaces the feed.
   */
  feedId?: string;
  /**
   * Parent project, folder, or organization
   * (`projects/{project}`, `folders/{folder}`,
   * `organizations/{organization}`). Defaults to the current project.
   * Immutable — changing it replaces the feed.
   */
  parent?: string;
  /**
   * Full resource names to subscribe to. Specify `assetNames` and/or
   * `assetTypes`. Example:
   * `//compute.googleapis.com/projects/p/zones/z/instances/i`.
   */
  assetNames?: string[];
  /**
   * Asset types to subscribe to. Example: `storage.googleapis.com/Bucket`.
   */
  assetTypes?: string[];
  /**
   * Asset content included in updates (`RESOURCE`, `IAM_POLICY`,
   * `ORG_POLICY`, `ACCESS_POLICY`, `OS_INVENTORY`, `RELATIONSHIP`).
   * Omitted returns name and type only.
   */
  contentType?: FeedContentType;
  /**
   * Relationship types to emit when `contentType` is `RELATIONSHIP`.
   */
  relationshipTypes?: string[];
  /**
   * Pub/Sub topic that receives asset updates
   * (`projects/{project}/topics/{topic}`). Alchemy grants the Cloud
   * Asset service agent `roles/pubsub.publisher` on the topic.
   */
  pubsubTopic: string;
  /**
   * CEL condition that filters published updates. When omitted, Alchemy
   * still stamps ownership into a no-op `true` condition.
   */
  condition?: FeedCondition;
};

export type Feed = Resource<
  "GCP.CloudAsset.Feed",
  FeedProps,
  {
    /** Full resource name `projects/{project}/feeds/{feed}`. */
    name: string;
    /** Feed id (last path segment). */
    feedId: string;
    /** Parent project, folder, or organization. */
    parent: string;
    /** Project id used when the feed was reconciled. */
    project: string;
    /** Full resource names the feed watches. */
    assetNames: string[];
    /** Asset types the feed watches. */
    assetTypes: string[];
    /** Content type included in updates. */
    contentType: string | undefined;
    /** Relationship types when `contentType` is `RELATIONSHIP`. */
    relationshipTypes: string[];
    /** Destination Pub/Sub topic. */
    pubsubTopic: string | undefined;
    /** User condition with the Alchemy ownership prefix stripped. */
    condition: FeedCondition | undefined;
  },
  never,
  Providers
>;

/**
 * A Cloud Asset Inventory feed that publishes asset updates to Pub/Sub.
 *
 * Feeds have no labels field — Alchemy stamps ownership into
 * `condition.description` so `list` / nuke can find them. Feed id and
 * parent are identity. Asset filters, content type, destination topic,
 * and condition update in place.
 *
 * ### Creating a Feed
 * **Example:** Watch storage buckets
 * ```typescript
 * const topic = yield* GCP.PubSub.Topic("AssetEvents", {});
 * const feed = yield* GCP.CloudAsset.Feed("Buckets", {
 *   pubsubTopic: topic.name,
 *   assetTypes: ["storage.googleapis.com/Bucket"],
 *   contentType: "RESOURCE",
 * });
 * ```
 *
 * **Example:** Named feed with a deletion filter
 * ```typescript
 * const feed = yield* GCP.CloudAsset.Feed("Buckets", {
 *   feedId: "bucket-deletes",
 *   pubsubTopic: topic.name,
 *   assetTypes: ["storage.googleapis.com/Bucket"],
 *   contentType: "RESOURCE",
 *   condition: {
 *     expression: "temporal_asset.deleted == true",
 *     title: "deletes",
 *     description: "publish deletions only",
 *   },
 * });
 * ```
 *
 * ### Updating a Feed
 * **Example:** Also watch Pub/Sub topics
 * ```typescript
 * // Same logical id, changed props: the feed is patched in place.
 * const feed = yield* GCP.CloudAsset.Feed("Buckets", {
 *   pubsubTopic: topic.name,
 *   assetTypes: [
 *     "storage.googleapis.com/Bucket",
 *     "pubsub.googleapis.com/Topic",
 *   ],
 *   contentType: "RESOURCE",
 * });
 * ```
 *
 * @resource
 * @category CloudAsset
 */
export const Feed = Resource<Feed>("GCP.CloudAsset.Feed");

export class FeedNotResolved extends Data.TaggedError(
  "GCP.CloudAsset.FeedNotResolved",
)<{
  name: string;
}> {}

const resourceName = (parent: string, feedId: string) =>
  `${parent}/feeds/${feedId}`;

const contentTypeOf = (value: string | undefined) =>
  !value || value === "CONTENT_TYPE_UNSPECIFIED" ? undefined : value;

const toUserCondition = (
  condition: cloudasset.Expr | undefined,
): FeedCondition | undefined => {
  if (condition === undefined) return undefined;
  const { description } = parseDescription(condition.description);
  const isInternalOnly =
    (condition.expression === undefined ||
      condition.expression === NO_OP_EXPRESSION) &&
    condition.title === undefined &&
    condition.location === undefined &&
    description === undefined;
  if (isInternalOnly) return undefined;
  return {
    expression: condition.expression,
    title: condition.title,
    description,
    location: condition.location,
  };
};

const desiredCondition = (
  ownership: Record<string, string>,
  condition: FeedCondition | undefined,
): cloudasset.Expr => ({
  expression: condition?.expression ?? NO_OP_EXPRESSION,
  title: condition?.title,
  location: condition?.location,
  description: encodeDescription(ownership, condition?.description),
});

const toAttrs = (feed: cloudasset.Feed, project: string) => {
  const name = feed.name ?? "";
  return {
    name,
    feedId: lastSegment(name),
    parent: parentOf(name, "feeds"),
    project,
    assetNames: feed.assetNames ?? [],
    assetTypes: feed.assetTypes ?? [],
    contentType: contentTypeOf(feed.contentType),
    relationshipTypes: feed.relationshipTypes ?? [],
    pubsubTopic: feed.feedOutputConfig?.pubsubDestination?.topic,
    condition: toUserCondition(feed.condition),
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : cloudasset
        .getFeeds({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const observe = (project: string, feedId: string, outputName?: string) =>
  Effect.gen(function* () {
    const parent = yield* scopeParent(project);
    const candidates = [outputName, resourceName(parent, feedId)].filter(
      (name): name is string => name !== undefined && name.length > 0,
    );
    for (const name of candidates) {
      const found = yield* getByName(name);
      if (found !== undefined) return found;
    }
    const feeds = yield* listFeeds(parent);
    return feeds.find((feed) => lastSegment(feed.name ?? "") === feedId);
  });

const toFeedBody = (
  news: FeedProps,
  condition: cloudasset.Expr,
): cloudasset.Feed => ({
  assetNames: news.assetNames,
  assetTypes: news.assetTypes,
  contentType: news.contentType,
  relationshipTypes: news.relationshipTypes,
  feedOutputConfig: {
    pubsubDestination: { topic: news.pubsubTopic },
  },
  condition,
});

export const FeedProvider = () =>
  Provider.succeed(Feed, {
    stables: ["name", "feedId", "parent", "project"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      return (
        replaceOn(olds?.feedId ?? output?.feedId, news.feedId) ??
        replaceOn(olds?.parent, news.parent)
      );
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const feedId = yield* toPhysicalId(id, olds?.feedId, output?.feedId);
      const existing = yield* observe(env.project, feedId, output?.name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* ownedByAlchemy(id, existing.condition?.description))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const parent = yield* scopeParent(env.project);
        const feeds = yield* listFeeds(parent);
        return feeds
          .filter((feed) => hasOwnershipMarker(feed.condition?.description))
          .map((feed) => toAttrs(feed, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const feedId = yield* toPhysicalId(id, news.feedId, output?.feedId);
      const parent = yield* scopeParent(env.project, news.parent);
      const name = resourceName(parent, feedId);
      const ownership = yield* createInternalLabels(id);
      const condition = desiredCondition(ownership, news.condition);
      const body = toFeedBody(news, condition);
      yield* grantCloudAssetPublisher(env.project, news.pubsubTopic);

      let current = yield* observe(env.project, feedId, output?.name);

      if (current === undefined) {
        const created = yield* cloudasset
          .createFeeds({
            parent,
            body: { feedId, feed: body },
          })
          .pipe(
            Effect.retry({
              while: (error) => error._tag === "BadRequest",
              times: 8,
              schedule: Schedule.spaced("2 seconds"),
            }),
            Effect.catchTag("Conflict", () =>
              observe(env.project, feedId, output?.name),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new FeedNotResolved({ name });
      }

      const currentName = current.name ?? name;
      const namesChanged = !sameStringList(current.assetNames, news.assetNames);
      const typesChanged = !sameStringList(current.assetTypes, news.assetTypes);
      const contentChanged = !sameText(
        contentTypeOf(current.contentType),
        contentTypeOf(news.contentType),
      );
      const relationshipsChanged = !sameStringList(
        current.relationshipTypes,
        news.relationshipTypes,
      );
      const topicChanged = !sameText(
        current.feedOutputConfig?.pubsubDestination?.topic,
        news.pubsubTopic,
      );
      const conditionChanged = !sameJson(current.condition, condition);
      const updateMask = updateMaskOf(
        namesChanged ? "asset_names" : undefined,
        typesChanged ? "asset_types" : undefined,
        contentChanged ? "content_type" : undefined,
        relationshipsChanged ? "relationship_types" : undefined,
        topicChanged ? "feed_output_config" : undefined,
        conditionChanged ? "condition" : undefined,
      );

      if (updateMask.length > 0) {
        current = yield* cloudasset.patchFeeds({
          name: currentName,
          body: {
            updateMask,
            feed: { ...body, name: currentName },
          },
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      yield* cloudasset
        .deleteFeeds({ name: output.name })
        .pipe(Effect.catchTag(["NotFound", "BadRequest"], () => Effect.void));
    }),
  });
