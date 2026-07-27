import type * as NFW from "@distilled.cloud/aws/network-firewall";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

/** Convert a Network Firewall `Tag[]` list into a plain record. */
export const nfwTagsToRecord = (
  tags: readonly NFW.Tag[] | undefined,
): Record<string, string> =>
  Object.fromEntries((tags ?? []).map((t) => [t.Key, t.Value]));

/** Convert a plain record into a Network Firewall `Tag[]` list. */
export const recordToNfwTags = (record: Record<string, string>): NFW.Tag[] =>
  Object.entries(record).map(([Key, Value]) => ({ Key, Value }));

// Explicitly-typed pipeable retry helpers. Inlining `Effect.retry` in a
// provider lifecycle op leaks `Retry.Return`'s conditional into declaration
// emit and widens the provider layer to `unknown` R for every consumer of
// `AWS.providers()`.

/**
 * Network Firewall rejects deletion of a rule group / firewall policy that is
 * still referenced (or was referenced moments ago) with
 * `InvalidOperationException`. Dependents are deleted first by the engine,
 * but the service releases the reference asynchronously — retry through a
 * short window.
 */
export const retryWhileNfwInUse = <A, E extends { readonly _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "InvalidOperationException",
    schedule: Schedule.max([Schedule.fixed("5 seconds"), Schedule.recurs(12)]),
  });

/**
 * A freshly-created rule group / policy can transiently return
 * `ResourceNotFoundException` from a follow-up describe. Bounded retry
 * through the eventual-consistency window.
 */
export const retryWhileNfwNotFound = <
  A,
  E extends { readonly _tag: string },
  R,
>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "ResourceNotFoundException",
    schedule: Schedule.max([Schedule.fixed("2 seconds"), Schedule.recurs(10)]),
  });
