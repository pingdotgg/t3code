import * as resourceSharing from "@distilled.cloud/cloudflare/resource-sharing";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";

import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

const TypeId = "Cloudflare.ResourceSharing.Share" as const;
type TypeId = typeof TypeId;

/**
 * Type of resource that can be shared across accounts/organizations.
 */
export type ShareableResourceType =
  | "custom-ruleset"
  | "gateway-policy"
  | "gateway-destination-ip"
  | "gateway-block-page-settings"
  | "gateway-extended-email-matching"
  | "idp-federation-grant";

/**
 * Lifecycle status of a share. Deletion is asynchronous — a deleted share
 * transitions `active → deleting → deleted`.
 */
export type ShareStatus = "active" | "deleting" | "deleted";

/**
 * A recipient of a share — exactly one of `accountId` / `organizationId`.
 */
export type ShareRecipientInput = {
  /**
   * Recipient account identifier. Exactly one of `accountId` /
   * `organizationId` must be set.
   */
  accountId?: string;
  /**
   * Recipient organization identifier. Exactly one of `accountId` /
   * `organizationId` must be set.
   */
  organizationId?: string;
};

/**
 * A resource entry shared by a share.
 */
export type ShareResourceInput = {
  /**
   * Type of the shared resource (e.g. `gateway-policy`).
   */
  resourceType: ShareableResourceType;
  /**
   * Identifier of the resource being shared (e.g. the gateway policy id).
   */
  resourceId: string;
  /**
   * Account that owns the resource being shared.
   * @default the current account
   */
  resourceAccountId?: string;
  /**
   * Resource metadata forwarded to the share API.
   * @default {}
   */
  meta?: unknown;
};

export type ShareProps = {
  /**
   * The name of the share. The only share-level mutable field. If omitted, a
   * unique name is generated from the app, stage, and logical ID.
   * @default ${app}-${stage}-${id}
   */
  name?: string;
  /**
   * Recipients of the share. The create API requires at least one. Changes
   * are reconciled via the recipient sub-API (add/remove deltas). Do not mix
   * with standalone `ShareRecipient` resources on the same share — the Share
   * provider treats this list as the full desired set.
   */
  recipients: ShareRecipientInput[];
  /**
   * Resources shared by the share. The create API requires at least one.
   * Changes are reconciled via the resource sub-API (`meta` updates in place;
   * changing `resourceType`/`resourceId` of an entry deletes and recreates
   * that entry). Do not mix with standalone `ShareResource` resources on the
   * same share — the Share provider treats this list as the full desired set.
   */
  resources: ShareResourceInput[];
};

export type ShareAttributes = {
  /**
   * Share identifier tag. Stable across updates.
   */
  shareId: string;
  /**
   * The Cloudflare account that owns (sends) the share.
   */
  accountId: string;
  /**
   * The name of the share.
   */
  name: string;
  /**
   * Lifecycle status of the share.
   */
  status: ShareStatus;
  /**
   * Whether the share targets an account or an organization.
   */
  targetType: "account" | "organization";
  /**
   * Whether this share is sent by or received by the current account.
   */
  kind: "sent" | "received";
  /**
   * Organization identifier of the owning account.
   */
  organizationId: string;
  /**
   * When the share was created.
   */
  created: string;
  /**
   * When the share was last modified.
   */
  modified: string;
};

export type Share = Resource<
  TypeId,
  ShareProps,
  ShareAttributes,
  never,
  Providers
>;

/**
 * A Cloudflare resource share — shares account-level configuration (gateway
 * policies, custom rulesets, IdP federation grants, …) with another account
 * or organization.
 *
 * The create API requires at least one recipient and one resource, so both
 * are seeded inline. Post-create changes to those arrays are reconciled
 * through the recipient/resource sub-APIs; only `name` is mutable on the
 * share itself. Deletion is asynchronous (`active → deleting → deleted`).
 * @resource
 * @product Resource Sharing
 * @category Account & Identity
 * @section Creating a Share
 * @example Share a gateway policy with another account
 * ```typescript
 * const policy = yield* Cloudflare.Gateway.Rule("BlockPhishing", {
 *   action: "block",
 *   traffic: 'dns.fqdn == "phishing.example"',
 *   filters: ["dns"],
 * });
 *
 * const share = yield* Cloudflare.ResourceSharing.Share("PolicyShare", {
 *   recipients: [{ accountId: "<recipient-account-id>" }],
 *   resources: [
 *     { resourceType: "gateway-policy", resourceId: policy.ruleId },
 *   ],
 * });
 * ```
 *
 * @section Updating a Share
 * @example Rename in place
 * ```typescript
 * const share = yield* Cloudflare.ResourceSharing.Share("PolicyShare", {
 *   name: "security-baseline-v2",
 *   recipients: [{ accountId: "<recipient-account-id>" }],
 *   resources: [
 *     { resourceType: "gateway-policy", resourceId: policy.ruleId },
 *   ],
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/fundamentals/manage-account-resources/
 */
export const Share = Resource<Share>(TypeId);

/**
 * Returns true if the given value is a Share resource.
 */
export const isShare = (value: unknown): value is Share =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const ShareProvider = () =>
  Provider.succeed(Share, {
    stables: ["shareId", "accountId", "organizationId", "created"],
    // Account collection — enumerate every share this account sends
    // (the ones we own and can delete), exhaustively paginated, mapped
    // into the same Attributes shape `read` returns. Deleted shares are
    // excluded since they no longer exist.
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      return yield* resourceSharing.listResourceSharings
        .pages({ accountId, kind: "sent", perPage: 50 })
        .pipe(
          Stream.runCollect,
          Effect.map((chunk) =>
            Array.from(chunk).flatMap((page) =>
              (page.result ?? [])
                .filter((s) => s.status !== "deleted")
                .map((s) => toAttributes(s, accountId)),
            ),
          ),
        );
    }),
    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news)) return undefined;
      const { accountId } = yield* yield* CloudflareEnvironment;
      if ((output?.accountId ?? accountId) !== accountId) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),
    read: Effect.fn(function* ({ id, olds, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;

      if (output?.shareId) {
        const observed = yield* getShare(acct, output.shareId);
        return observed ? toAttributes(observed, acct) : undefined;
      }
      // Cold read — recover from lost state by matching the deterministic
      // physical name among shares we sent. Names are not unique on
      // Cloudflare's side; an exact match is the best identity we have.
      const name = yield* createShareName(id, olds?.name);
      const match = yield* findByName(acct, name);
      return match ? toAttributes(match, acct) : undefined;
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const name = yield* createShareName(id, news.name);
      const desiredRecipients = news.recipients.map((r) => ({
        accountId: r.accountId as string | undefined,
        organizationId: r.organizationId as string | undefined,
      }));
      const desiredResources = news.resources.map((r) => ({
        resourceType: r.resourceType,
        resourceId: r.resourceId as string,
        resourceAccountId: (r.resourceAccountId as string) ?? accountId,
        meta: r.meta ?? {},
      }));

      // Observe — the shareId cached on `output` is a hint, not a
      // guarantee: a missing (or fully deleted) share falls through and
      // we recreate.
      const observed = output?.shareId
        ? yield* getShare(output.accountId ?? accountId, output.shareId)
        : undefined;

      if (!observed) {
        // Ensure — greenfield (or out-of-band delete): the create API
        // requires both arrays, so seed them inline. Share names are not
        // unique so there is no AlreadyExists race to tolerate.
        const created = yield* resourceSharing.createResourceSharing({
          accountId,
          name,
          recipients: desiredRecipients,
          resources: desiredResources,
        });
        return toAttributes(created, accountId);
      }

      const acct = output?.accountId ?? accountId;

      // Sync name — the only share-level mutable field.
      if (observed.name !== name) {
        yield* resourceSharing.updateResourceSharing({
          accountId: acct,
          shareId: observed.id,
          name,
        });
      }

      // Sync recipients — diff observed cloud state against desired and
      // apply add/remove deltas through the recipient sub-API.
      const observedRecipients = yield* resourceSharing.listRecipients
        .items({ accountId: acct, shareId: observed.id, perPage: 50 })
        .pipe(
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
        );
      const liveRecipients = observedRecipients.filter(
        (r) => r.associationStatus !== "disassociated",
      );
      for (const desired of desiredRecipients) {
        const match = liveRecipients.find(
          (r) => r.accountId === (desired.accountId ?? desired.organizationId),
        );
        if (!match) {
          yield* resourceSharing.createRecipient({
            pathAccountId: acct,
            shareId: observed.id,
            bodyAccountId: desired.accountId,
            organizationId: desired.organizationId,
          });
        }
      }
      for (const live of liveRecipients) {
        const wanted = desiredRecipients.some(
          (d) => (d.accountId ?? d.organizationId) === live.accountId,
        );
        if (!wanted) {
          yield* resourceSharing
            .deleteRecipient({
              accountId: acct,
              shareId: observed.id,
              recipientId: live.id,
            })
            .pipe(Effect.catchTag("ShareRecipientNotFound", () => Effect.void));
        }
      }

      // Sync resources — keyed by (resourceType, resourceId): create
      // missing entries, update `meta` in place, delete extras.
      const observedResources = yield* resourceSharing.listResources
        .items({ accountId: acct, shareId: observed.id, perPage: 50 })
        .pipe(
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
        );
      const liveResources = observedResources.filter(
        (r) => r.status !== "deleted" && r.status !== "deleting",
      );
      for (const desired of desiredResources) {
        const match = liveResources.find(
          (r) =>
            r.resourceType === desired.resourceType &&
            r.resourceId === desired.resourceId,
        );
        if (!match) {
          yield* resourceSharing.createResource({
            accountId: acct,
            shareId: observed.id,
            resourceType: desired.resourceType,
            resourceId: desired.resourceId,
            resourceAccountId: desired.resourceAccountId,
            meta: desired.meta,
          });
        } else if (
          JSON.stringify(match.meta ?? {}) !==
          JSON.stringify(desired.meta ?? {})
        ) {
          yield* resourceSharing.updateResource({
            accountId: acct,
            shareId: observed.id,
            shareResourceId: match.id,
            meta: desired.meta,
          });
        }
      }
      for (const live of liveResources) {
        const wanted = desiredResources.some(
          (d) =>
            d.resourceType === live.resourceType &&
            d.resourceId === live.resourceId,
        );
        if (!wanted) {
          yield* resourceSharing
            .deleteResource({
              accountId: acct,
              shareId: observed.id,
              shareResourceId: live.id,
            })
            .pipe(Effect.catchTag("ShareResourceNotFound", () => Effect.void));
        }
      }

      // Return — re-read for fresh attributes after the sub-API syncs.
      const fresh = yield* getShare(acct, observed.id);
      return fresh ? toAttributes(fresh, acct) : toAttributes(observed, acct);
    }),
    delete: Effect.fn(function* ({ output }) {
      // Deletion is asynchronous (`active → deleting → deleted`); the
      // DELETE call itself is idempotent against a missing share.
      yield* resourceSharing
        .deleteResourceSharing({
          accountId: output.accountId,
          shareId: output.shareId,
        })
        .pipe(Effect.catchTag("ShareNotFound", () => Effect.void));
    }),
  });

type ObservedShare = resourceSharing.GetResourceSharingResponse;

/**
 * Read a share by id, mapping "gone" (`ShareNotFound`, Cloudflare error code
 * 1004 / HTTP 404) and the terminal `deleted` status to `undefined`.
 */
const getShare = (accountId: string, shareId: string) =>
  resourceSharing.getResourceSharing({ accountId, shareId }).pipe(
    Effect.map((share): ObservedShare | undefined =>
      share.status === "deleted" ? undefined : share,
    ),
    Effect.catchTag("ShareNotFound", () => Effect.succeed(undefined)),
  );

/**
 * Find a sent share by exact name. If several shares carry the same name,
 * pick the oldest for determinism.
 */
const findByName = (accountId: string, name: string) =>
  resourceSharing
    .listResourceSharings({ accountId, kind: "sent", perPage: 50 })
    .pipe(
      Effect.map((list) =>
        list.result
          .filter((s) => s.name === name && s.status !== "deleted")
          .sort((a, b) => a.created.localeCompare(b.created))
          .at(0),
      ),
    );

const createShareName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    return name ?? (yield* createPhysicalName({ id, lowercase: true }));
  });

const toAttributes = (
  share:
    | ObservedShare
    | resourceSharing.CreateResourceSharingResponse
    | resourceSharing.ListResourceSharingsResponse["result"][number],
  accountId: string,
): ShareAttributes => ({
  shareId: share.id,
  accountId,
  name: share.name,
  // Distilled widens generated string enums to open unions (`string & {}`).
  status: share.status as ShareStatus,
  targetType: share.targetType as "account" | "organization",
  kind: (share.kind ?? "sent") as "sent" | "received",
  organizationId: share.organizationId,
  created: share.created,
  modified: share.modified,
});
