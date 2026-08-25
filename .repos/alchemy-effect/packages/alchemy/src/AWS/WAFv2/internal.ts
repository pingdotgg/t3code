import { Region as AwsRegion } from "@distilled.cloud/aws/Region";
import type * as WAFV2 from "@distilled.cloud/aws/wafv2";
import * as wafv2 from "@distilled.cloud/aws/wafv2";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { diffTags } from "../../Tags.ts";

/**
 * Scope of a WAFv2 resource.
 *
 * - `REGIONAL` — protects regional resources (ALB, API Gateway, AppSync,
 *   Cognito user pool, App Runner, Verified Access) and follows the ambient
 *   AWS region.
 * - `CLOUDFRONT` — protects CloudFront distributions and must live in
 *   `us-east-1`; the providers pin the region automatically.
 */
export type WafScope = "REGIONAL" | "CLOUDFRONT";

const CLOUDFRONT_REGION = "us-east-1" as const;

/**
 * WAFv2 `CLOUDFRONT`-scoped resources exist exclusively in `us-east-1`
 * (like ACM certificates for CloudFront). Pin the distilled `Region`
 * service for CLOUDFRONT scope; REGIONAL scope follows the ambient region.
 *
 * `AwsRegion`'s service value is an `Effect<RegionName>` (see
 * `@distilled.cloud/aws/Region`), so it must be provided as an effect, not a
 * bare string.
 *
 * @internal
 */
export const withWafScope = <A, E, R>(
  scope: WafScope,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  scope === "CLOUDFRONT"
    ? effect.pipe(
        Effect.provideService(AwsRegion, Effect.succeed(CLOUDFRONT_REGION)),
      )
    : effect;

/**
 * WAFv2 mutations (update/delete) use `LockToken` optimistic concurrency.
 * The caller re-reads the entity (obtaining a fresh `LockToken`) inside
 * `self`, so retrying the whole effect on `WAFOptimisticLockException`
 * converges after concurrent writers.
 *
 * Explicitly typed: inlining `Effect.retry` with options in provider
 * lifecycle code widens the provider layer to `unknown` in declaration emit.
 *
 * @internal
 */
export const retryOptimisticLock = <A, E extends { _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "WAFOptimisticLockException",
    schedule: Schedule.max([Schedule.fixed("1 second"), Schedule.recurs(8)]),
  });

/**
 * WAF changes take "a few seconds to a number of minutes" to propagate.
 * A freshly created web ACL (or rule group) referenced by another call —
 * or a freshly created protected resource (e.g. a Cognito user pool) that
 * WAF cannot "retrieve" yet — surfaces `WAFUnavailableEntityException`
 * until propagation completes. Retry it on a bounded schedule (~90s
 * total); fresh Cognito user pools routinely need more than 40s.
 *
 * @internal
 */
export const retryUnavailableEntity = <A, E extends { _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "WAFUnavailableEntityException",
    schedule: Schedule.max([Schedule.fixed("3 seconds"), Schedule.recurs(30)]),
  });

/**
 * Like {@link retryUnavailableEntity} but with a ~150s budget. Associating
 * a web ACL with a freshly created protected resource (Cognito user pool,
 * ALB, …) surfaces `WAFUnavailableEntityException` until the resource
 * propagates to WAF — observed to routinely exceed 90s for new Cognito
 * user pools (Terraform retries this for 5 minutes).
 *
 * @internal
 */
export const retryUnavailableEntityLong = <A, E extends { _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "WAFUnavailableEntityException",
    schedule: Schedule.max([Schedule.fixed("3 seconds"), Schedule.recurs(50)]),
  });

/**
 * Deleting a web ACL shortly after its association was removed can surface
 * `WAFAssociatedItemException` until disassociation propagates. Retry it
 * (and propagation-flavored unavailability) on a bounded schedule (~30s).
 *
 * @internal
 */
export const retryAssociatedItem = <A, E extends { _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) =>
      e._tag === "WAFAssociatedItemException" ||
      e._tag === "WAFUnavailableEntityException",
    schedule: Schedule.max([Schedule.fixed("2 seconds"), Schedule.recurs(15)]),
  });

/**
 * Read the observed tags of a WAFv2 entity as a plain record.
 *
 * @internal
 */
export const fetchWafTags = Effect.fn(function* (
  scope: WafScope,
  resourceArn: string,
) {
  const tags: Record<string, string> = {};
  let marker: string | undefined;
  // WAF tag sets are small; bound pagination defensively.
  for (let page = 0; page < 10; page++) {
    const response = yield* withWafScope(
      scope,
      wafv2.listTagsForResource({
        ResourceARN: resourceArn,
        NextMarker: marker,
        Limit: 100,
      }),
    );
    const list = response.TagInfoForResource?.TagList ?? [];
    for (const tag of list) {
      tags[tag.Key] = tag.Value;
    }
    // WAF returns an empty-string NextMarker on the terminal page.
    if (!response.NextMarker || list.length === 0) {
      break;
    }
    marker = response.NextMarker;
  }
  return tags;
});

/**
 * Sync a WAFv2 entity's tags to the desired set by diffing against the
 * OBSERVED cloud tags (never `olds`/`output`).
 *
 * @internal
 */
export const syncWafTags = Effect.fn(function* (
  scope: WafScope,
  resourceArn: string,
  desiredTags: Record<string, string>,
) {
  const observed = yield* fetchWafTags(scope, resourceArn);
  const { removed, upsert } = diffTags(observed, desiredTags);
  if (upsert.length > 0) {
    yield* withWafScope(
      scope,
      wafv2.tagResource({ ResourceARN: resourceArn, Tags: upsert }),
    );
  }
  if (removed.length > 0) {
    yield* withWafScope(
      scope,
      wafv2.untagResource({ ResourceARN: resourceArn, TagKeys: removed }),
    );
  }
});

/**
 * Restore `ByteMatchStatement.SearchString` blobs inside a rule tree.
 *
 * Resource props survive the engine's plan/state serialization as plain
 * JSON, so a `Uint8Array` SearchString arrives at the provider as an
 * index-keyed object (`{ "0": 47, ... }`) or a number array. Distilled
 * requires a real `Uint8Array` to base64-encode the blob on the wire, so
 * walk the (recursive) statement tree and coerce every SearchString back.
 *
 * @internal
 */
export const normalizeWafRules = (
  rules: WAFV2.Rule[] | undefined,
): WAFV2.Rule[] =>
  (rules ?? []).map((rule) => normalizeRuleValue(rule) as WAFV2.Rule);

const normalizeRuleValue = (value: unknown): unknown => {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(normalizeRuleValue);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        key === "SearchString"
          ? toSearchString(nested)
          : normalizeRuleValue(nested),
      ]),
    );
  }
  return value;
};

const toSearchString = (value: unknown): Uint8Array => {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (typeof value === "string") {
    return new TextEncoder().encode(value);
  }
  if (Array.isArray(value)) {
    return Uint8Array.from(value as number[]);
  }
  if (value !== null && typeof value === "object") {
    // Index-keyed object — integer keys iterate in ascending order.
    return Uint8Array.from(Object.values(value as Record<string, number>));
  }
  return new Uint8Array();
};
