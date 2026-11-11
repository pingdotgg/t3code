import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

/**
 * Derives a deterministic Service Catalog idempotency token from the
 * resource's instance ID so retried creates never double-provision.
 * Tokens must match `[a-zA-Z0-9][a-zA-Z0-9_-]*` and be ≤ 128 chars.
 */
export const idempotencyToken = (instanceId: string): string =>
  instanceId.replaceAll(/[^a-zA-Z0-9]/g, "").slice(0, 64) || "alchemy";

/**
 * Retries an effect while Service Catalog reports the resource as in use
 * (`ResourceInUseException`) on a bounded schedule (~30s). Deleting a
 * portfolio or product right after its associations were removed can
 * transiently hit this due to eventual consistency.
 *
 * NOTE: extracted to module scope with an explicit return annotation —
 * inlining `Effect.retry` in a provider lifecycle op leaves `Retry.Return`'s
 * conditional type unresolved in declaration emit, which widens the
 * provider's layer to an `unknown` R and poisons `AWS.providers()` for
 * every downstream consumer.
 */
export const retryWhileResourceInUse = <A, E extends { _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "ResourceInUseException",
    schedule: Schedule.max([Schedule.fixed("2 seconds"), Schedule.recurs(10)]),
  });

/**
 * Polls a boolean check on a bounded fixed schedule until it observes
 * `true` (or gives up silently after `attempts`). Service Catalog
 * association lists are eventually consistent, so a freshly-created
 * association may take a few seconds to appear.
 */
export const awaitVisible = <E, R>(
  check: Effect.Effect<boolean, E, R>,
  attempts = 10,
): Effect.Effect<void, E, R> =>
  Effect.gen(function* () {
    for (let i = 0; i < attempts; i++) {
      if (yield* check) return;
      yield* Effect.sleep("2 seconds");
    }
  });
