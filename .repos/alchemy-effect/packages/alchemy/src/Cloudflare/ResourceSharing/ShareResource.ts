import * as resourceSharing from "@distilled.cloud/cloudflare/resource-sharing";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";

import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import type { ShareableResourceType, ShareStatus } from "./Share.ts";

const TypeId = "Cloudflare.ResourceSharing.ShareResource" as const;
type TypeId = typeof TypeId;

export type ShareResourceProps = {
  /**
   * The share this resource belongs to. Changing the share triggers a
   * replacement.
   */
  shareId: string;
  /**
   * Type of the shared resource (e.g. `gateway-policy`). Changing the type
   * triggers a replacement.
   */
  resourceType: ShareableResourceType;
  /**
   * Identifier of the resource being shared (e.g. the gateway policy id).
   * Changing it triggers a replacement.
   */
  resourceId: string;
  /**
   * Account that owns the resource being shared. Changing it triggers a
   * replacement.
   * @default the current account
   */
  resourceAccountId?: string;
  /**
   * Resource metadata forwarded to the share API. The only mutable field.
   * @default {}
   */
  meta?: unknown;
};

export type ShareResourceAttributes = {
  /**
   * Server-assigned share-resource identifier — distinct from the shared
   * `resourceId`. Stable across updates.
   */
  shareResourceId: string;
  /**
   * The Cloudflare account that owns the share.
   */
  accountId: string;
  /**
   * The share this resource belongs to.
   */
  shareId: string;
  /**
   * Type of the shared resource.
   */
  resourceType: ShareableResourceType;
  /**
   * Identifier of the resource being shared.
   */
  resourceId: string;
  /**
   * Account that owns the resource being shared.
   */
  resourceAccountId: string;
  /**
   * Resource metadata.
   */
  meta: unknown;
  /**
   * Version of the shared resource.
   */
  resourceVersion: number;
  /**
   * Lifecycle status of the share resource.
   */
  status: ShareStatus;
  /**
   * When the share resource was created.
   */
  created: string;
  /**
   * When the share resource was last modified.
   */
  modified: string;
};

export type ShareResource = Resource<
  TypeId,
  ShareResourceProps,
  ShareResourceAttributes,
  never,
  Providers
>;

/**
 * A resource entry on an existing Cloudflare share — adds a shareable
 * resource (gateway policy, custom ruleset, …) to a `Share` incrementally.
 *
 * Only `meta` is mutable in place; changing the share, type, id, or owning
 * account triggers a replacement. A share must always retain at least one
 * resource — the last entry cannot be deleted (delete the `Share` instead).
 * Do not manage the same entry both inline on `Share.resources` and through
 * this resource.
 * @resource
 * @product Resource Sharing
 * @category Account & Identity
 * @section Adding a Resource to a Share
 * @example Share an additional gateway policy
 * ```typescript
 * const entry = yield* Cloudflare.ResourceSharing.ShareResource("ExtraPolicy", {
 *   shareId: share.shareId,
 *   resourceType: "gateway-policy",
 *   resourceId: policy.ruleId,
 * });
 * ```
 *
 * @section Updating Metadata
 * @example Update `meta` in place
 * ```typescript
 * const entry = yield* Cloudflare.ResourceSharing.ShareResource("ExtraPolicy", {
 *   shareId: share.shareId,
 *   resourceType: "gateway-policy",
 *   resourceId: policy.ruleId,
 *   meta: { note: "rotated" },
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/fundamentals/manage-account-resources/
 */
export const ShareResource = Resource<ShareResource>(TypeId);

/**
 * Returns true if the given value is a ShareResource resource.
 */
export const isShareResource = (value: unknown): value is ShareResource =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const ShareResourceProvider = () =>
  Provider.succeed(ShareResource, {
    stables: [
      "shareResourceId",
      "accountId",
      "shareId",
      "resourceType",
      "resourceId",
      "resourceAccountId",
      "created",
    ],
    diff: Effect.fn(function* ({ olds, news, output }) {
      if (!isResolved(news)) return undefined;
      const { accountId } = yield* yield* CloudflareEnvironment;
      if ((output?.accountId ?? accountId) !== accountId) {
        return { action: "replace" } as const;
      }
      // The share is a path parameter — an entry cannot move between
      // shares in place. By diff time both sides are resolved strings.
      const oldShareId = output?.shareId ?? olds?.shareId;
      if (
        typeof oldShareId === "string" &&
        typeof news.shareId === "string" &&
        oldShareId !== news.shareId
      ) {
        return { action: "replace" } as const;
      }
      const oldType = output?.resourceType ?? olds?.resourceType;
      if (oldType !== undefined && oldType !== news.resourceType) {
        return { action: "replace" } as const;
      }
      const oldResourceId = output?.resourceId ?? olds?.resourceId;
      if (
        typeof oldResourceId === "string" &&
        typeof news.resourceId === "string" &&
        oldResourceId !== news.resourceId
      ) {
        return { action: "replace" } as const;
      }
      const oldOwner = output?.resourceAccountId ?? olds?.resourceAccountId;
      const newOwner = news.resourceAccountId ?? accountId;
      if (
        typeof oldOwner === "string" &&
        typeof newOwner === "string" &&
        oldOwner !== newOwner
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),
    read: Effect.fn(function* ({ olds, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;
      const shareId = output?.shareId ?? (olds?.shareId as string | undefined);
      if (shareId === undefined) return undefined;

      if (output?.shareResourceId) {
        const observed = yield* getEntry(acct, shareId, output.shareResourceId);
        return observed ? toAttributes(observed, acct, shareId) : undefined;
      }
      // Cold read — recover from lost state by matching the natural key
      // (resourceType, resourceId) among the share's live entries.
      const resourceType = olds?.resourceType as
        | ShareableResourceType
        | undefined;
      const resourceId = olds?.resourceId as string | undefined;
      if (resourceType === undefined || resourceId === undefined) {
        return undefined;
      }
      const match = yield* findEntry(acct, shareId, resourceType, resourceId);
      return match ? toAttributes(match, acct, shareId) : undefined;
    }),
    reconcile: Effect.fn(function* ({ news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;
      const shareId = news.shareId as string;
      const resourceId = news.resourceId as string;
      const desiredMeta = news.meta ?? {};

      // Observe — the id cached on `output` is a hint; fall through to a
      // natural-key lookup so an AlreadyExists race converges instead of
      // failing, then to create.
      const observed =
        (output?.shareResourceId
          ? yield* getEntry(acct, shareId, output.shareResourceId)
          : undefined) ??
        (yield* findEntry(acct, shareId, news.resourceType, resourceId));

      if (!observed) {
        // Ensure — greenfield (or out-of-band delete).
        const created = yield* resourceSharing.createResource({
          accountId: acct,
          shareId,
          resourceType: news.resourceType,
          resourceId,
          resourceAccountId: (news.resourceAccountId as string) ?? acct,
          meta: desiredMeta,
        });
        return toAttributes(created, acct, shareId);
      }

      // Sync — `meta` is the only mutable field; skip the PUT on a no-op.
      if (JSON.stringify(observed.meta ?? {}) !== JSON.stringify(desiredMeta)) {
        const updated = yield* resourceSharing.updateResource({
          accountId: acct,
          shareId,
          shareResourceId: observed.id,
          meta: desiredMeta,
        });
        return toAttributes(updated, acct, shareId);
      }
      return toAttributes(observed, acct, shareId);
    }),
    delete: Effect.fn(function* ({ output }) {
      // Deletion is asynchronous (`status: deleting`); the DELETE call is
      // idempotent against a missing entry. Deleting the last resource of
      // a share is a genuine dependency violation and propagates.
      yield* resourceSharing
        .deleteResource({
          accountId: output.accountId,
          shareId: output.shareId,
          shareResourceId: output.shareResourceId,
        })
        .pipe(Effect.catchTag("ShareResourceNotFound", () => Effect.void));
    }),
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // Parent fan-out: a ShareResource is a sub-resource of a Share with
      // no account-wide enumeration of its own. Enumerate every share we
      // send (account-scoped), then list each share's resource entries
      // with bounded concurrency, paginating both levels exhaustively.
      const shares = yield* resourceSharing.listResourceSharings
        .pages({ accountId, kind: "sent" })
        .pipe(
          Stream.runCollect,
          Effect.map((chunk) =>
            Array.from(chunk).flatMap((page) =>
              (page.result ?? []).filter((s) => s.status !== "deleted"),
            ),
          ),
        );
      const rows = yield* Effect.forEach(
        shares,
        (share) =>
          resourceSharing.listResources
            .pages({ accountId, shareId: share.id })
            .pipe(
              Stream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk).flatMap((page) =>
                  (page.result ?? [])
                    .filter(
                      (r) => r.status !== "deleted" && r.status !== "deleting",
                    )
                    .map((entry) => toAttributes(entry, accountId, share.id)),
                ),
              ),
              // A share removed out-of-band between enumeration and the
              // per-share list surfaces as ShareNotFound — skip it.
              Effect.catchTag("ShareNotFound", () =>
                Effect.succeed([] as ShareResourceAttributes[]),
              ),
            ),
        { concurrency: 10 },
      );
      return rows.flat();
    }),
  });

type ObservedEntry = resourceSharing.GetResourceResponse;

/**
 * Read a share-resource entry by id, mapping "gone"
 * (`ShareResourceNotFound`, HTTP 404) and the terminal `deleted` status to
 * `undefined`.
 */
const getEntry = (
  accountId: string,
  shareId: string,
  shareResourceId: string,
) =>
  resourceSharing.getResource({ accountId, shareId, shareResourceId }).pipe(
    Effect.map((entry): ObservedEntry | undefined =>
      entry.status === "deleted" ? undefined : entry,
    ),
    Effect.catchTag("ShareResourceNotFound", () => Effect.succeed(undefined)),
  );

/**
 * Find a live entry by its natural key (resourceType, resourceId). A missing
 * share surfaces as `ShareNotFound` — treat it as "no entry".
 */
const findEntry = (
  accountId: string,
  shareId: string,
  resourceType: ShareableResourceType,
  resourceId: string,
) =>
  resourceSharing
    .listResources({ accountId, shareId, resourceType, perPage: 50 })
    .pipe(
      Effect.map((list) =>
        list.result.find(
          (r) =>
            r.resourceId === resourceId &&
            r.status !== "deleted" &&
            r.status !== "deleting",
        ),
      ),
      Effect.catchTag("ShareNotFound", () => Effect.succeed(undefined)),
    );

const toAttributes = (
  entry:
    | ObservedEntry
    | resourceSharing.CreateResourceResponse
    | resourceSharing.UpdateResourceResponse
    | resourceSharing.ListResourcesResponse["result"][number],
  accountId: string,
  shareId: string,
): ShareResourceAttributes => ({
  shareResourceId: entry.id,
  accountId,
  shareId,
  // Distilled widens generated string enums to open unions (`string & {}`).
  resourceType: entry.resourceType as ShareableResourceType,
  resourceId: entry.resourceId,
  resourceAccountId: entry.resourceAccountId,
  meta: entry.meta,
  resourceVersion: entry.resourceVersion,
  status: entry.status as ShareStatus,
  created: entry.created,
  modified: entry.modified,
});
