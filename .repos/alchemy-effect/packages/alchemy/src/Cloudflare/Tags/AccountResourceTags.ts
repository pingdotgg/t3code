import * as resourceTagging from "@distilled.cloud/cloudflare/resource-tagging";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";

import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import type { Input } from "../../Input.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { recordsEqual } from "../../Util/equal.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

const TypeId = "Cloudflare.Tags.AccountResourceTags" as const;
type TypeId = typeof TypeId;

/**
 * Account-level resource types that can carry tags via Cloudflare's unified
 * resource-tagging API.
 */
export type AccountTagResourceType =
  | "access_application"
  | "access_group"
  | "account"
  | "ai_gateway"
  | "alerting_policy"
  | "alerting_webhook"
  | "cloudflared_tunnel"
  | "d1_database"
  | "durable_object_namespace"
  | "gateway_list"
  | "gateway_rule"
  | "image"
  | "kv_namespace"
  | "queue"
  | "r2_bucket"
  | "resource_share"
  | "stream_live_input"
  | "stream_video"
  | "worker"
  | "worker_version"
  | (string & {});

export interface AccountResourceTagsProps {
  /**
   * The type of the account-level resource the tags attach to (e.g.
   * `kv_namespace`, `worker`, `r2_bucket`, or `account` for the account
   * itself).
   *
   * Stable — the `(resourceType, resourceId)` pair is the tag set's
   * identity, so changing it triggers a replacement. Declared as plain
   * `string` (narrowed to {@link AccountTagResourceType}) so `diff` can
   * compare without resolving an `Input`.
   */
  resourceType: AccountTagResourceType;
  /**
   * The ID of the resource the tags attach to (e.g. a KV namespace ID or
   * the account ID itself for `resourceType: "account"`).
   *
   * Stable — changing it triggers a replacement.
   */
  resourceId: string;
  /**
   * Worker identifier. Required when `resourceType` is `worker_version`,
   * ignored otherwise.
   *
   * Stable — changing it triggers a replacement.
   */
  workerId?: string;
  /**
   * Key/value tags to attach to the resource. The PUT API replaces the
   * full tag set, so this is the complete desired set — keys absent here
   * are removed from the resource on the next reconcile.
   *
   * An empty record is indistinguishable from "no tags" on Cloudflare's
   * side, so prefer at least one entry.
   */
  tags: Record<string, string>;
}

export interface AccountResourceTagsAttributes {
  /** The Cloudflare account the tagged resource belongs to. */
  accountId: string;
  /** The type of the tagged resource. */
  resourceType: AccountTagResourceType;
  /** The ID of the tagged resource. */
  resourceId: string;
  /** Worker identifier (only set for `worker_version` resources). */
  workerId: string | undefined;
  /** The full tag set currently attached to the resource. */
  tags: Record<string, string>;
  /** ETag of the tag set, usable for optimistic concurrency control. */
  etag: string;
}

export type AccountResourceTags = Resource<
  TypeId,
  AccountResourceTagsProps,
  AccountResourceTagsAttributes,
  never,
  Providers
>;

/**
 * Key/value tags attached to an account-level Cloudflare resource via the
 * unified resource-tagging API (open beta).
 *
 * The tag SET is the resource: `PUT` replaces the full set, and deleting
 * this resource clears every tag from the target. Cloudflare reports an
 * untagged (or unknown) resource as an empty tag set rather than a 404, so
 * an empty set is treated as "absent".
 *
 * Safety: tags carry no ownership markers. On a cold read (no prior state)
 * a non-empty tag set on the target resource is reported as `Unowned`, and
 * the engine refuses to take it over (i.e. clobber the existing tags)
 * unless `--adopt` or `adopt(true)` is set.
 * @resource
 * @product Resource Tagging
 * @category Account & Identity
 * @section Tagging a resource
 * @example Tag a KV namespace
 * ```typescript
 * const kv = yield* Cloudflare.KV.Namespace("cache", {});
 *
 * yield* Cloudflare.Tags.AccountResourceTags("cache-tags", {
 *   resourceType: "kv_namespace",
 *   resourceId: kv.namespaceId,
 *   tags: { team: "platform", env: "production" },
 * });
 * ```
 *
 * @example Tag the account itself
 * ```typescript
 * yield* Cloudflare.Tags.AccountResourceTags("account-tags", {
 *   resourceType: "account",
 *   resourceId: accountId,
 *   tags: { "cost-center": "eng-42" },
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/fundamentals/account/tags/
 */
export const AccountResourceTags = Resource<AccountResourceTags>(TypeId);

/**
 * Returns true if the given value is an AccountResourceTags resource.
 */
export const isAccountResourceTags = (
  value: unknown,
): value is AccountResourceTags =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const AccountResourceTagsProvider = () =>
  Provider.succeed(AccountResourceTags, {
    stables: ["accountId", "resourceType", "resourceId", "workerId"],

    // Account-wide enumeration: `GET /accounts/{id}/tags/resources` returns
    // every tagged resource in the account, so the tag set of each is directly
    // hydratable into the `read` Attributes shape.
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      return yield* resourceTagging.listResourceTaggings
        .pages({ accountId })
        .pipe(
          Stream.runCollect,
          Effect.map((chunk) =>
            Array.from(chunk).flatMap((page) =>
              (page.result ?? []).map(
                (item): AccountResourceTagsAttributes => ({
                  accountId,
                  resourceType: item.type,
                  resourceId: item.id,
                  workerId:
                    "workerId" in item ? (item.workerId as string) : undefined,
                  tags: narrowTags(item.tags),
                  etag: item.etag,
                }),
              ),
            ),
          ),
        );
    }),

    diff: Effect.fn(function* ({ olds = {}, news }) {
      const o = olds as Partial<AccountResourceTagsProps>;
      const n = news as AccountResourceTagsProps;
      if (o.resourceType !== undefined && o.resourceType !== n.resourceType) {
        return { action: "replace" } as const;
      }
      // resourceId / workerId are Input<string>; by diff time persisted
      // olds are concrete strings — compare only when both sides are.
      if (
        typeof o.resourceId === "string" &&
        typeof n.resourceId === "string" &&
        o.resourceId !== n.resourceId
      ) {
        return { action: "replace" } as const;
      }
      if (
        typeof o.workerId === "string" &&
        typeof n.workerId === "string" &&
        o.workerId !== n.workerId
      ) {
        return { action: "replace" } as const;
      }
    }),

    read: Effect.fn(function* ({ output, olds }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;
      // At plan time `olds` may still hold unresolved Output proxies (e.g.
      // an adoption pre-check before the referenced resource deploys) —
      // only fall back to them once resolved.
      const resolvedOlds =
        olds !== undefined && isResolved(olds) ? olds : undefined;
      const resourceId = output?.resourceId ?? resolvedOlds?.resourceId;
      const resourceType = output?.resourceType ?? resolvedOlds?.resourceType;
      const workerId = output?.workerId ?? resolvedOlds?.workerId;
      if (!resourceId || !resourceType) return undefined;

      const observed = yield* resourceTagging.getAccountTag({
        accountId: acct,
        resourceId,
        resourceType,
        workerId,
      });
      const tags = narrowTags(observed.tags);
      // Cloudflare reports untagged (and unknown) resources as an empty
      // tag set — that is "gone" for this resource.
      if (Object.keys(tags).length === 0) return undefined;

      const attrs: AccountResourceTagsAttributes = {
        accountId: acct,
        resourceType,
        resourceId,
        workerId,
        tags,
        etag: observed.etag,
      };
      // Cold read without prior state: a non-empty tag set exists but we
      // cannot prove we created it (tags carry no ownership markers), so
      // gate takeover behind the adopt policy.
      return output ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;
      // Inputs have been resolved to concrete strings by Plan.
      const resourceId = news.resourceId as string;
      const workerId = news.workerId as string | undefined;
      const desired = resolveTags(news.tags);

      // Observe — cloud state is authoritative. The GET never 404s for a
      // missing/untagged resource; it returns an empty tag set, so the
      // same call covers greenfield, update, and adoption.
      const observed = yield* resourceTagging.getAccountTag({
        accountId: acct,
        resourceId,
        resourceType: news.resourceType,
        workerId,
      });

      // Sync — PUT is a full replace, so the only decision is whether the
      // observed set already equals the desired set (skip the write).
      if (recordsEqual(narrowTags(observed.tags), desired)) {
        return {
          accountId: acct,
          resourceType: news.resourceType,
          resourceId,
          workerId,
          tags: desired,
          etag: observed.etag,
        } satisfies AccountResourceTagsAttributes;
      }

      const updated = yield* resourceTagging.putAccountTag({
        accountId: acct,
        resourceId,
        resourceType: news.resourceType,
        workerId,
        tags: desired,
      });
      return {
        accountId: acct,
        resourceType: news.resourceType,
        resourceId,
        workerId,
        tags: narrowTags(updated.tags),
        etag: updated.etag,
      } satisfies AccountResourceTagsAttributes;
    }),

    delete: Effect.fn(function* ({ output }) {
      // The DELETE endpoint is idempotent — Cloudflare returns 204 even
      // for resources that were never tagged.
      yield* resourceTagging.deleteAccountTag({
        accountId: output.accountId,
        resourceId: output.resourceId,
        resourceType: output.resourceType,
        workerId: output.workerId,
      });
    }),
  });

/** Narrow distilled's `Record<string, unknown>` tag values to strings. */
const narrowTags = (tags: Record<string, unknown>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(tags).map(([k, v]) => [k, String(v)] as const),
  );

/** Resolve `Input<string>` tag values (already concrete after Plan). */
const resolveTags = (
  tags: Record<string, Input<string>>,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(tags).map(([k, v]) => [k, v as string] as const),
  );
