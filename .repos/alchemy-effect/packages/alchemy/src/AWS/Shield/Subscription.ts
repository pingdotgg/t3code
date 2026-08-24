import * as shield from "@distilled.cloud/aws/shield";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

/** Whether the Shield Advanced subscription renews automatically. */
export type SubscriptionAutoRenew = "ENABLED" | "DISABLED";

export interface SubscriptionProps {
  /**
   * Whether the subscription renews automatically at the end of the 1-year
   * commitment. Mutable — but AWS only allows changing it in the 30 days
   * before the current period ends.
   * @default "ENABLED"
   */
  autoRenew?: SubscriptionAutoRenew;
}

export interface Subscription extends Resource<
  "AWS.Shield.Subscription",
  SubscriptionProps,
  {
    /** ARN of the subscription. */
    subscriptionArn: string | undefined;
    /** Start of the current subscription period (ISO timestamp). */
    startTime: string | undefined;
    /** End of the current subscription period (ISO timestamp). */
    endTime: string | undefined;
    /** Length of the commitment, in seconds (1 year). */
    timeCommitmentInSeconds: number | undefined;
    /** Whether the subscription auto-renews. */
    autoRenew: string | undefined;
    /** Whether proactive engagement by the Shield Response Team is enabled. */
    proactiveEngagementStatus: string | undefined;
  },
  never,
  Providers
> {}

/**
 * The account-level AWS Shield Advanced subscription.
 *
 * :::caution
 * Creating this resource subscribes the account to Shield Advanced at
 * **$3,000/month with a mandatory 1-year commitment** (billed to the
 * Organizations payer account). AWS refuses `DeleteSubscription` until the
 * commitment ends, so destroying this resource before then leaves the
 * subscription in place (a warning is logged); after the commitment it is
 * cancelled for real.
 * :::
 *
 * @section Subscribing to Shield Advanced
 * @example Subscribe with Auto-Renew
 * ```typescript
 * const subscription = yield* Shield.Subscription("Shield", {});
 * ```
 *
 * @example Subscribe and Disable Auto-Renew
 * ```typescript
 * const subscription = yield* Shield.Subscription("Shield", {
 *   autoRenew: "DISABLED",
 * });
 * ```
 */
const SubscriptionResource = Resource<Subscription>("AWS.Shield.Subscription");

export { SubscriptionResource as Subscription };

// `describeSubscription` fails with the (patched) typed `SubscriptionNotFound`
// when the account is not subscribed — collapse it to `undefined`.
const observeSubscription = shield.describeSubscription({}).pipe(
  Effect.map((r) => r.Subscription),
  Effect.catchTag("SubscriptionNotFound", () => Effect.succeed(undefined)),
);

const buildAttrs = (subscription: shield.Subscription) => ({
  subscriptionArn: subscription.SubscriptionArn,
  startTime: subscription.StartTime?.toISOString(),
  endTime: subscription.EndTime?.toISOString(),
  timeCommitmentInSeconds: subscription.TimeCommitmentInSeconds,
  autoRenew: subscription.AutoRenew,
  proactiveEngagementStatus: subscription.ProactiveEngagementStatus,
});

export const SubscriptionProvider = () =>
  Provider.effect(
    SubscriptionResource,
    Effect.gen(function* () {
      return {
        stables: ["subscriptionArn"],

        read: Effect.fn(function* ({ output }) {
          const subscription = yield* observeSubscription;
          if (!subscription) return undefined;
          const attrs = buildAttrs(subscription);
          // Shield subscriptions carry no tags, so ownership cannot be
          // verified from cloud state alone. Treat it as ours only when we
          // have prior state; otherwise gate adoption behind --adopt.
          return output ? attrs : Unowned(attrs);
        }),

        // Account-level singleton — report the single subscription, if any.
        list: () =>
          observeSubscription.pipe(
            Effect.map((subscription) =>
              subscription ? [buildAttrs(subscription)] : [],
            ),
          ),

        reconcile: Effect.fn(function* ({ news, session }) {
          // 1. OBSERVE — cloud state is authoritative.
          let subscription = yield* observeSubscription;

          // 2. ENSURE — subscribe if not already; tolerate the AlreadyExists
          //    race.
          if (!subscription) {
            yield* shield
              .createSubscription({})
              .pipe(
                Effect.catchTag(
                  "ResourceAlreadyExistsException",
                  () => Effect.void,
                ),
              );
            subscription = yield* shield
              .describeSubscription({})
              .pipe(Effect.map((r) => r.Subscription));
            if (!subscription) {
              return yield* Effect.fail(
                new Error(
                  "Failed to create or read the Shield Advanced subscription",
                ),
              );
            }
          }

          // 3. SYNC auto-renew — observed ↔ desired; AWS only accepts the
          //    change within 30 days of the period end, so skip the call on
          //    a no-op.
          const desiredAutoRenew = news.autoRenew ?? "ENABLED";
          if (subscription.AutoRenew !== desiredAutoRenew) {
            yield* shield.updateSubscription({ AutoRenew: desiredAutoRenew });
            const refreshed = yield* shield
              .describeSubscription({})
              .pipe(Effect.map((r) => r.Subscription));
            subscription = refreshed ?? subscription;
          }

          // 4. RETURN fresh attributes.
          if (subscription.SubscriptionArn !== undefined) {
            yield* session.note(subscription.SubscriptionArn);
          }
          return buildAttrs(subscription);
        }),

        delete: Effect.fn(function* () {
          // AWS refuses to cancel a Shield Advanced subscription before the
          // 1-year commitment ends (LockedSubscriptionException). Warn and
          // leave it in place rather than wedging the destroy.
          yield* shield.deleteSubscription({}).pipe(
            Effect.catchTag(
              ["SubscriptionNotFound", "ResourceNotFoundException"],
              () => Effect.void,
            ),
            Effect.catchTag("LockedSubscriptionException", (error) =>
              Effect.logWarning(
                "Shield Advanced subscription is locked for its 1-year commitment and cannot be cancelled yet; leaving it in place.",
                error,
              ),
            ),
          );
        }),
      };
    }),
  );
