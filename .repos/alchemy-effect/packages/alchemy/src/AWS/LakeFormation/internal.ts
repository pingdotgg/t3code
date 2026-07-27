import * as lf from "@distilled.cloud/aws/lakeformation";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

/**
 * Bounded retry through `ConcurrentModificationException` — Lake Formation
 * serializes grant/revoke/settings mutations and rejects concurrent writers.
 * Explicitly typed so declaration emit does not widen the provider layer (see
 * PATTERNS §7 on inlined `Effect.retry`).
 */
export const retryWhileConcurrentModification = <
  A,
  E extends { _tag: string },
  R,
>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "ConcurrentModificationException",
    schedule: Schedule.max([Schedule.fixed("2 seconds"), Schedule.recurs(10)]),
  });

/**
 * Bounded retry through `InvalidLakeFormationPrincipal` — a freshly-created
 * IAM role/user takes ~10s to propagate before Lake Formation accepts it as a
 * principal ("Invalid principal, arn: ..." surfaced as a typed synthetic
 * error via the distilled patch). Explicitly typed for the same
 * declaration-emit reason as above.
 */
export const retryWhileInvalidPrincipal = <A, E extends { _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "InvalidLakeFormationPrincipal",
    schedule: Schedule.max([Schedule.fixed("3 seconds"), Schedule.recurs(10)]),
  });

/**
 * Observe the permissions a specific principal holds on a resource.
 *
 * IMPORTANT: this deliberately lists by `Resource` only and filters entries
 * client-side by exact principal identifier. Listing with a `Principal`
 * filter makes Lake Formation fold the `IAM_ALLOWED_PRINCIPALS` group grant
 * (typically `ALL`) into the principal's effective permissions, which would
 * make the reconciler believe `ALL` was granted directly (verified live).
 */
export const observePrincipalPermissions = Effect.fn(
  "AWS.LakeFormation.observePrincipalPermissions",
)(function* (
  principal: string,
  resource: lf.Resource,
  catalogId: string | undefined,
) {
  const pages = yield* lf.listPermissions
    .pages({ CatalogId: catalogId, Resource: resource })
    .pipe(Stream.runCollect);
  const entries = Array.from(pages)
    .flatMap((page) => page.PrincipalResourcePermissions ?? [])
    .filter((e) => e.Principal?.DataLakePrincipalIdentifier === principal);
  const permissions = [
    ...new Set(entries.flatMap((e) => e.Permissions ?? [])),
  ].sort();
  const permissionsWithGrantOption = [
    ...new Set(entries.flatMap((e) => e.PermissionsWithGrantOption ?? [])),
  ].sort();
  return { permissions, permissionsWithGrantOption };
});
