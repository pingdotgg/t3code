import * as resourceTagging from "@distilled.cloud/cloudflare/resource-tagging";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import { Unowned } from "../../AdoptPolicy.ts";
import type { Input } from "../../Input.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { recordsEqual } from "../../Util/equal.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

const TypeId = "Cloudflare.Tags.ZoneResourceTags" as const;
type TypeId = typeof TypeId;

// A target resource (e.g. a freshly-created DNS record) propagates
// eventually-consistently to Cloudflare's tag index; the tag API answers
// `ZoneTagResourceNotFound` (404) until it appears. Bounded-retry the tag
// calls on that typed tag so reconcile waits out the propagation window.
const targetVisibleRetry = {
  while: (e: { _tag: string }) => e._tag === "ZoneTagResourceNotFound",
  schedule: Schedule.max([
    Schedule.exponential("500 millis"),
    Schedule.recurs(10),
  ]),
} as const;

/**
 * Zone-level resource types that can carry tags via Cloudflare's unified
 * resource-tagging API.
 */
export type ZoneTagResourceType =
  | "access_application_policy"
  | "api_gateway_operation"
  | "custom_certificate"
  | "custom_hostname"
  | "dns_record"
  | "managed_client_certificate"
  | "zone"
  | (string & {});

export interface ZoneResourceTagsProps {
  /**
   * Zone the tagged resource lives in.
   *
   * Stable — changing the zone triggers replacement.
   */
  zoneId: string;
  /**
   * The type of the zone-level resource the tags attach to (e.g.
   * `dns_record`, `custom_hostname`, or `zone` for the zone itself).
   *
   * Stable — the `(resourceType, resourceId)` pair is the tag set's
   * identity, so changing it triggers a replacement. Declared as plain
   * `string` (narrowed to {@link ZoneTagResourceType}) so `diff` can
   * compare without resolving an `Input`.
   */
  resourceType: ZoneTagResourceType;
  /**
   * The ID of the resource the tags attach to (e.g. a DNS record ID or
   * the zone ID itself for `resourceType: "zone"`).
   *
   * Stable — changing it triggers a replacement.
   */
  resourceId: string;
  /**
   * Access application identifier. Required when `resourceType` is
   * `access_application_policy`, ignored otherwise.
   *
   * Stable — changing it triggers a replacement.
   */
  accessApplicationId?: string;
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

export interface ZoneResourceTagsAttributes {
  /** Zone the tagged resource lives in. */
  zoneId: string;
  /** The type of the tagged resource. */
  resourceType: ZoneTagResourceType;
  /** The ID of the tagged resource. */
  resourceId: string;
  /** Access application identifier (only set for `access_application_policy`). */
  accessApplicationId: string | undefined;
  /** The full tag set currently attached to the resource. */
  tags: Record<string, string>;
  /** ETag of the tag set, usable for optimistic concurrency control. */
  etag: string;
}

export type ZoneResourceTags = Resource<
  TypeId,
  ZoneResourceTagsProps,
  ZoneResourceTagsAttributes,
  never,
  Providers
>;

/**
 * Key/value tags attached to a zone-level Cloudflare resource via the
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
 * @example Tag a DNS record
 * ```typescript
 * const record = yield* Cloudflare.DNS.Record("api", {
 *   zoneId: zone.zoneId,
 *   name: "api.example.com",
 *   type: "A",
 *   content: "203.0.113.42",
 * });
 *
 * yield* Cloudflare.Tags.ZoneResourceTags("api-tags", {
 *   zoneId: zone.zoneId,
 *   resourceType: "dns_record",
 *   resourceId: record.recordId,
 *   tags: { team: "platform", env: "production" },
 * });
 * ```
 *
 * @example Tag the zone itself
 * ```typescript
 * yield* Cloudflare.Tags.ZoneResourceTags("zone-tags", {
 *   zoneId: zone.zoneId,
 *   resourceType: "zone",
 *   resourceId: zone.zoneId,
 *   tags: { "cost-center": "eng-42" },
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/fundamentals/account/tags/
 */
export const ZoneResourceTags = Resource<ZoneResourceTags>(TypeId);

/**
 * Returns true if the given value is a ZoneResourceTags resource.
 */
export const isZoneResourceTags = (value: unknown): value is ZoneResourceTags =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const ZoneResourceTagsProvider = () =>
  Provider.succeed(ZoneResourceTags, {
    stables: ["zoneId", "resourceType", "resourceId", "accessApplicationId"],

    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // The account-wide `GET /accounts/{id}/tags/resources` enumerates
      // every tagged resource in the account in one paginated call. The
      // zone-scoped variants (the ones this resource manages) are exactly
      // those that carry a `zoneId` in the response union; account-level
      // variants (worker, kv_namespace, …) lack it and are filtered out.
      return yield* resourceTagging.listResourceTaggings
        .pages({ accountId })
        .pipe(
          Stream.runCollect,
          Effect.map((chunk) =>
            Array.from(chunk).flatMap((page) =>
              (page.result ?? [])
                .filter((item): item is ZoneScopedTagging => "zoneId" in item)
                .map(
                  (item): ZoneResourceTagsAttributes => ({
                    zoneId: item.zoneId,
                    resourceType: item.type,
                    resourceId: item.id,
                    accessApplicationId:
                      "accessApplicationId" in item
                        ? item.accessApplicationId
                        : undefined,
                    tags: narrowTags(item.tags),
                    etag: item.etag,
                  }),
                ),
            ),
          ),
        );
    }),

    diff: Effect.fn(function* ({ olds = {}, news }) {
      const o = olds as Partial<ZoneResourceTagsProps>;
      const n = news as ZoneResourceTagsProps;
      if (o.resourceType !== undefined && o.resourceType !== n.resourceType) {
        return { action: "replace" } as const;
      }
      // zoneId / resourceId / accessApplicationId are Input<string>; by
      // diff time persisted olds are concrete strings — compare only when
      // both sides are.
      if (
        typeof o.zoneId === "string" &&
        typeof n.zoneId === "string" &&
        o.zoneId !== n.zoneId
      ) {
        return { action: "replace" } as const;
      }
      if (
        typeof o.resourceId === "string" &&
        typeof n.resourceId === "string" &&
        o.resourceId !== n.resourceId
      ) {
        return { action: "replace" } as const;
      }
      if (
        typeof o.accessApplicationId === "string" &&
        typeof n.accessApplicationId === "string" &&
        o.accessApplicationId !== n.accessApplicationId
      ) {
        return { action: "replace" } as const;
      }
    }),

    read: Effect.fn(function* ({ output, olds }) {
      const zoneId = output?.zoneId ?? (olds?.zoneId as string | undefined);
      const resourceId =
        output?.resourceId ?? (olds?.resourceId as string | undefined);
      const resourceType = output?.resourceType ?? olds?.resourceType;
      const accessApplicationId =
        output?.accessApplicationId ??
        (olds?.accessApplicationId as string | undefined);
      if (!zoneId || !resourceId || !resourceType) return undefined;

      const observed = yield* resourceTagging
        .getZoneTag({
          zoneId,
          resourceId,
          resourceType,
          accessApplicationId,
        })
        // A 404 means the target resource no longer exists; its tags are
        // gone with it.
        .pipe(
          Effect.catchTag("ZoneTagResourceNotFound", () =>
            Effect.succeed(undefined),
          ),
        );
      if (observed === undefined) return undefined;
      const tags = narrowTags(observed.tags);
      // Cloudflare reports untagged (and unknown) resources as an empty
      // tag set — that is "gone" for this resource.
      if (Object.keys(tags).length === 0) return undefined;

      const attrs: ZoneResourceTagsAttributes = {
        zoneId,
        resourceType,
        resourceId,
        accessApplicationId,
        tags,
        etag: observed.etag,
      };
      // Cold read without prior state: a non-empty tag set exists but we
      // cannot prove we created it (tags carry no ownership markers), so
      // gate takeover behind the adopt policy.
      return output ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      // Inputs have been resolved to concrete strings by Plan.
      const zoneId = news.zoneId as string;
      const resourceId = news.resourceId as string;
      const accessApplicationId = news.accessApplicationId as
        | string
        | undefined;
      const desired = resolveTags(news.tags);

      // Observe — cloud state is authoritative. The GET never 404s for a
      // valid-but-untagged resource (it returns an empty tag set), so the
      // same call covers greenfield, update, and adoption. It *does* 404
      // (`ZoneTagResourceNotFound`) when the target resource itself isn't
      // visible yet — a freshly-created DNS record propagates eventually-
      // consistently to the tag index — so bounded-retry until it appears.
      const observed = yield* resourceTagging
        .getZoneTag({
          zoneId,
          resourceId,
          resourceType: news.resourceType,
          accessApplicationId,
        })
        .pipe(Effect.retry(targetVisibleRetry));

      // Sync — PUT is a full replace, so the only decision is whether the
      // observed set already equals the desired set (skip the write).
      if (recordsEqual(narrowTags(observed.tags), desired)) {
        return {
          zoneId,
          resourceType: news.resourceType,
          resourceId,
          accessApplicationId,
          tags: desired,
          etag: observed.etag,
        } satisfies ZoneResourceTagsAttributes;
      }

      const updated = yield* resourceTagging
        .putZoneTag({
          zoneId,
          resourceId,
          resourceType: news.resourceType,
          accessApplicationId,
          tags: desired,
        })
        .pipe(Effect.retry(targetVisibleRetry));
      return {
        zoneId,
        resourceType: news.resourceType,
        resourceId,
        accessApplicationId,
        tags: narrowTags(updated.tags),
        etag: updated.etag,
      } satisfies ZoneResourceTagsAttributes;
    }),

    delete: Effect.fn(function* ({ output }) {
      // The DELETE endpoint is idempotent — Cloudflare returns 204 even
      // for resources that were never tagged.
      yield* resourceTagging.deleteZoneTag({
        zoneId: output.zoneId,
        resourceId: output.resourceId,
        resourceType: output.resourceType,
        accessApplicationId: output.accessApplicationId,
      });
    }),
  });

/**
 * The zone-scoped variants of the `listResourceTaggings` response union —
 * the items that carry a `zoneId` (dns_record, custom_hostname,
 * custom_certificate, managed_client_certificate, access_application_policy,
 * api_gateway_operation, zone). These are exactly the resources this provider
 * manages tags for.
 */
type ZoneScopedTagging = Extract<
  resourceTagging.ListResourceTaggingsResponse["result"][number],
  { zoneId: string }
>;

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
