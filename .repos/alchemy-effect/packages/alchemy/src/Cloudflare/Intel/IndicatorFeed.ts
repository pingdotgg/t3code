import * as intel from "@distilled.cloud/cloudflare/intel";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";
import crypto from "node:crypto";

import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

const TypeId = "Cloudflare.Intel.IndicatorFeed" as const;
type TypeId = typeof TypeId;

export interface IndicatorFeedProps {
  /**
   * The name of the indicator feed. Not unique on Cloudflare's side, but
   * used as the cold-state recovery identity, so keep it unique within the
   * account. If omitted, a unique name is generated from the app, stage,
   * and logical ID.
   * @default ${app}-${stage}-${id}
   */
  name?: string;
  /**
   * Human-readable description of the feed.
   */
  description?: string;
  /**
   * Whether the indicator feed can be attributed to a provider (consumers
   * see who published it).
   * @default false
   */
  isAttributable?: boolean;
  /**
   * Whether the indicator feed data can be downloaded by consumers.
   * @default false
   */
  isDownloadable?: boolean;
  /**
   * Whether the indicator feed is exposed to customers (publicly listed).
   * @default false
   */
  isPublic?: boolean;
  /**
   * Inline STIX 2.x content for the feed's snapshot. When provided, the
   * content is uploaded via the snapshot endpoint whenever it changes
   * (tracked by content hash). Cloudflare processes uploads asynchronously
   * — see the `latestUploadStatus` attribute.
   */
  snapshot?: string;
}

export interface IndicatorFeedAttributes {
  /** The server-assigned numeric identifier for the indicator feed. */
  feedId: number;
  /** The Cloudflare account the feed belongs to. */
  accountId: string;
  /** The name of the indicator feed. */
  name: string;
  /** The description of the indicator feed. */
  description: string | undefined;
  /** Whether the feed can be attributed to a provider. */
  isAttributable: boolean;
  /** Whether the feed data can be downloaded by consumers. */
  isDownloadable: boolean;
  /** Whether the feed is exposed to customers. */
  isPublic: boolean;
  /** When the feed was created. */
  createdOn: string | undefined;
  /** When the feed was last modified. */
  modifiedOn: string | undefined;
  /**
   * Status of the latest snapshot upload (`Mirroring`, `Unifying`,
   * `Loading`, `Provisioning`, `Complete`, or `Error`), if any.
   */
  latestUploadStatus: string | undefined;
  /**
   * SHA-256 hash of the last snapshot content uploaded by this provider.
   * Used to skip re-uploading unchanged content.
   */
  snapshotHash: string | undefined;
}

export type IndicatorFeed = Resource<
  TypeId,
  IndicatorFeedProps,
  IndicatorFeedAttributes,
  never,
  Providers
>;

/**
 * A Cloudflare custom Indicator Feed (Cloudforce One threat intelligence).
 *
 * Indicator feeds let approved accounts publish their own threat-intel
 * indicators (domains, IPs, URLs) that consumer accounts can subscribe to
 * via Gateway or download directly. Creating feeds requires the account to
 * be approved as a feed provider (a Cloudforce One entitlement) — without
 * it, creation fails with the typed `IndicatorFeedsNotEntitled` error.
 *
 * :::warning
 * Cloudflare's API exposes **no delete endpoint** for indicator feeds.
 * Destroying this resource orphans the feed on Cloudflare's side (a warning
 * is logged). To avoid leaking feeds across deployments, the provider
 * adopts an existing feed with the same name instead of creating a
 * duplicate.
 * :::
 * @resource
 * @product Intel
 * @category Observability & Analytics
 * @section Creating a Feed
 * @example Basic feed
 * ```typescript
 * const feed = yield* Cloudflare.Intel.IndicatorFeed("threat-feed", {
 *   description: "Indicators observed by our honeypots",
 * });
 * ```
 *
 * @example Public, downloadable feed
 * ```typescript
 * const feed = yield* Cloudflare.Intel.IndicatorFeed("public-feed", {
 *   name: "acme-public-indicators",
 *   description: "Acme Corp public threat indicators",
 *   isPublic: true,
 *   isDownloadable: true,
 *   isAttributable: true,
 * });
 * ```
 *
 * @section Publishing Indicators
 * @example Upload a STIX 2.x snapshot inline
 * ```typescript
 * const feed = yield* Cloudflare.Intel.IndicatorFeed("threat-feed", {
 *   description: "Indicators observed by our honeypots",
 *   snapshot: JSON.stringify({
 *     type: "bundle",
 *     id: "bundle--0a242344-3c0b-4fdb-9f59-3e8c4a4f6b3a",
 *     objects: [],
 *   }),
 * });
 * ```
 *
 * @section Sharing a Feed
 * @example Grant another account access
 * ```typescript
 * yield* Cloudflare.Intel.IndicatorFeedPermission("partner-access", {
 *   feedId: feed.feedId,
 *   accountTag: "023e105f4ecef8ad9ca31a8372d0c353",
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/security-center/indicator-feeds/
 */
export const IndicatorFeed = Resource<IndicatorFeed>(TypeId);

/**
 * Returns true if the given value is an IndicatorFeed resource.
 */
export const isIndicatorFeed = (value: unknown): value is IndicatorFeed =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const IndicatorFeedProvider = () =>
  Provider.succeed(IndicatorFeed, {
    stables: ["feedId", "accountId", "createdOn"],

    // Account collection — enumerate every indicator feed owned by the
    // ambient account. The list endpoint returns a thin row (no
    // `latestUploadStatus`), so hydrate each id via `getFeed` to produce the
    // exact `read` Attributes shape. Accounts without the Cloudforce One feed
    // entitlement are rejected with the typed `Forbidden` tag — treat that as
    // an empty collection rather than failing the enumeration.
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const ids = yield* intel.listIndicatorFeeds.pages({ accountId }).pipe(
        Stream.runCollect,
        Effect.map((chunk) =>
          Array.from(chunk).flatMap((page) =>
            (page.result ?? [])
              .map((f) => f.id)
              .filter((id): id is number => id != null),
          ),
        ),
        Effect.catchTag("Forbidden", () => Effect.succeed([] as number[])),
      );
      const rows = yield* Effect.forEach(
        ids,
        (feedId) =>
          getFeed(accountId, feedId).pipe(
            Effect.map((observed) =>
              observed
                ? toAttributes(observed, accountId, undefined)
                : undefined,
            ),
            // A feed may vanish between list and get, or the account may
            // lack access to an individual feed — skip either case.
            Effect.catchTag("Forbidden", () => Effect.succeed(undefined)),
          ),
        { concurrency: 10 },
      );
      return rows.filter(
        (row): row is IndicatorFeedAttributes => row !== undefined,
      );
    }),

    diff: Effect.fn(function* ({ news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      if (!isResolved(news)) return undefined;
      // Feeds cannot move between accounts (and cannot be deleted, so a
      // replacement would orphan the old feed) — but a different target
      // account still means a different physical resource.
      if ((output?.accountId ?? accountId) !== accountId) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, output, olds }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;

      if (output?.feedId !== undefined) {
        const observed = yield* getFeed(acct, output.feedId);
        return observed
          ? toAttributes(observed, acct, output.snapshotHash)
          : undefined;
      }
      // Cold read — recover from lost state by matching the deterministic
      // physical name. Names are not unique on Cloudflare's side; an exact
      // match on our generated/explicit name is the best identity we have.
      const name = yield* createFeedName(id, olds?.name);
      const match = yield* findByName(acct, name);
      if (match?.id != null) {
        const observed = yield* getFeed(acct, match.id);
        return observed ? toAttributes(observed, acct, undefined) : undefined;
      }
      return undefined;
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const name = yield* createFeedName(id, news.name);

      // Observe — the feedId cached on `output` is a hint, not a
      // guarantee. Because feeds can never be deleted, a missing cache
      // falls back to a lookup by name so reruns adopt the existing feed
      // instead of leaking a duplicate.
      let observed =
        output?.feedId !== undefined
          ? yield* getFeed(output.accountId ?? accountId, output.feedId)
          : undefined;
      if (!observed) {
        const match = yield* findByName(accountId, name);
        if (match?.id != null) {
          observed = yield* getFeed(accountId, match.id);
        }
      }

      // Ensure — greenfield: create the feed with name + description; the
      // visibility flags are only settable via update, so fall through to
      // the sync step with the freshly observed state.
      if (!observed) {
        const created = yield* intel.createIndicatorFeed({
          accountId,
          name,
          description: news.description,
        });
        if (created.id == null) {
          // The create response is fully optional in the API schema; fall
          // back to the by-name lookup for the id we just created.
          const match = yield* findByName(accountId, name);
          observed =
            match?.id != null ? yield* getFeed(accountId, match.id) : undefined;
        } else {
          observed = yield* getFeed(accountId, created.id);
        }
      }
      if (!observed || observed.id == null) {
        return yield* Effect.fail(
          new intel.IndicatorFeedNotFound({
            code: 0,
            message: `Indicator feed "${name}" was not observable after creation`,
          }),
        );
      }
      const feedId = observed.id;

      // Sync — diff observed cloud state against desired settings and
      // apply only when dirty.
      const desired = {
        name,
        description: news.description,
        isAttributable: news.isAttributable ?? false,
        isDownloadable: news.isDownloadable ?? false,
        isPublic: news.isPublic ?? false,
      };
      const dirty =
        (observed.name ?? undefined) !== desired.name ||
        (news.description !== undefined &&
          (observed.description ?? undefined) !== desired.description) ||
        (observed.isAttributable ?? false) !== desired.isAttributable ||
        (observed.isDownloadable ?? false) !== desired.isDownloadable ||
        (observed.isPublic ?? false) !== desired.isPublic;
      if (dirty) {
        yield* intel.updateIndicatorFeed({
          accountId,
          feedId,
          ...desired,
        });
      }

      // Sync snapshot — upload inline STIX content whenever its hash
      // differs from what we last uploaded. Uploads are processed
      // asynchronously by Cloudflare (see `latestUploadStatus`).
      let snapshotHash = output?.snapshotHash;
      if (news.snapshot !== undefined) {
        const hash = yield* sha256(news.snapshot);
        if (hash !== output?.snapshotHash) {
          yield* intel.putIndicatorFeedSnapshot({
            accountId,
            feedId,
            source: news.snapshot,
          });
        }
        snapshotHash = hash;
      }

      const final = yield* getFeed(accountId, feedId);
      if (!final) {
        return yield* Effect.fail(
          new intel.IndicatorFeedNotFound({
            code: 0,
            message: `Indicator feed ${feedId} disappeared during reconcile`,
          }),
        );
      }
      return toAttributes(final, accountId, snapshotHash);
    }),

    delete: Effect.fn(function* ({ output }) {
      // Cloudflare's API has no delete endpoint for indicator feeds — the
      // feed is orphaned on the account. Reconcile adopts same-named feeds,
      // so re-creating this resource later reuses the orphan.
      yield* Effect.logWarning(
        `Cloudflare indicator feeds cannot be deleted via the API — ` +
          `feed ${output.feedId} ("${output.name}") on account ` +
          `${output.accountId} is left in place.`,
      );
    }),
  });

type ObservedFeed = intel.GetIndicatorFeedResponse;

/**
 * Read a feed by id, mapping "gone" — Cloudflare answers HTTP 403 with
 * "Feed N does not exist or this account does not have access", surfaced
 * as the typed `IndicatorFeedNotFound` — to `undefined`.
 */
const getFeed = (accountId: string, feedId: number) =>
  intel.getIndicatorFeed({ accountId, feedId }).pipe(
    Effect.map((f): ObservedFeed | undefined => f),
    Effect.catchTag("IndicatorFeedNotFound", () => Effect.succeed(undefined)),
  );

/**
 * Find a feed by exact name. The list endpoint has no filter, so match
 * client-side; if several feeds carry the same name, pick the oldest for
 * determinism.
 */
const findByName = (accountId: string, name: string) =>
  intel.listIndicatorFeeds.items({ accountId }).pipe(
    Stream.filter((f) => f.name === name),
    Stream.runCollect,
    Effect.map((chunk) =>
      Array.from(chunk)
        .sort((a, b) => (a.createdOn ?? "").localeCompare(b.createdOn ?? ""))
        .at(0),
    ),
  );

const createFeedName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    return name ?? (yield* createPhysicalName({ id, lowercase: true }));
  });

const sha256 = (content: string) =>
  Effect.sync(() => crypto.createHash("sha256").update(content).digest("hex"));

const toAttributes = (
  feed: ObservedFeed,
  accountId: string,
  snapshotHash: string | undefined,
): IndicatorFeedAttributes => ({
  feedId: feed.id ?? 0,
  accountId,
  name: feed.name ?? "",
  description: feed.description ?? undefined,
  isAttributable: feed.isAttributable ?? false,
  isDownloadable: feed.isDownloadable ?? false,
  isPublic: feed.isPublic ?? false,
  createdOn: feed.createdOn ?? undefined,
  modifiedOn: feed.modifiedOn ?? undefined,
  latestUploadStatus: feed.latestUploadStatus ?? undefined,
  snapshotHash,
});
