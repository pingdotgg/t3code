import * as mm from "@distilled.cloud/aws/mailmanager";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  createInternalTags,
  createTagsList,
  hasAlchemyTags,
} from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import { readMailManagerTags, syncMailManagerTags } from "./internal.ts";

export interface AddonSubscriptionProps {
  /**
   * Name of the Add On product to subscribe to (e.g. `TRENDMICRO_VSAPI`,
   * `SPAMHAUS_DBL`, `ABUSIX_MAIL_INTELLIGENCE`). Subscribing accepts the Add
   * On's terms of use and additional pricing. Immutable — changing the name
   * replaces the subscription.
   */
  addonName: string;
  /**
   * Tags applied to the subscription. Alchemy ownership tags are merged in
   * automatically.
   */
  tags?: Record<string, string>;
}

export interface AddonSubscription extends Resource<
  "AWS.MailManager.AddonSubscription",
  AddonSubscriptionProps,
  {
    /** Server-assigned ID of the Add On subscription. */
    addonSubscriptionId: string;
    /** ARN of the Add On subscription. */
    addonSubscriptionArn: string;
    /** Name of the subscribed Add On product. */
    addonName: string;
  },
  never,
  Providers
> {}

/**
 * An SES Mail Manager Add On subscription — the acceptance of a third-party
 * Add On's terms of use and additional pricing. An
 * {@link AddonInstance} created from the subscription is what rule sets and
 * traffic policies actually reference.
 *
 * Subscriptions are immutable after creation (only tags update in place).
 *
 * :::warning
 * Creating a subscription accepts the Add On's **additional pricing**.
 * :::
 * @resource
 * @section Subscribing to an Add On
 * @example Spamhaus DBL
 * ```typescript
 * import * as MailManager from "alchemy/AWS/MailManager";
 *
 * const subscription = yield* MailManager.AddonSubscription("Spamhaus", {
 *   addonName: "SPAMHAUS_DBL",
 * });
 * const instance = yield* MailManager.AddonInstance("SpamhausInstance", {
 *   addonSubscriptionId: subscription.addonSubscriptionId,
 * });
 * ```
 */
export const AddonSubscription = Resource<AddonSubscription>(
  "AWS.MailManager.AddonSubscription",
);

export const AddonSubscriptionProvider = () =>
  Provider.effect(
    AddonSubscription,
    Effect.gen(function* () {
      const getById = (addonSubscriptionId: string) =>
        mm
          .getAddonSubscription({ AddonSubscriptionId: addonSubscriptionId })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );

      const listAll = mm.listAddonSubscriptions.pages({}).pipe(
        Stream.runCollect,
        Effect.map((chunk) =>
          Array.from(chunk).flatMap((page) => page.AddonSubscriptions ?? []),
        ),
      );

      // Subscriptions have no user-supplied name — recover identity after a
      // lost state write by searching for our ownership tags.
      const findByAlchemyTags = Effect.fn(function* (id: string) {
        const subscriptions = yield* listAll;
        for (const subscription of subscriptions) {
          if (subscription.AddonSubscriptionArn === undefined) continue;
          const tags = yield* readMailManagerTags(
            subscription.AddonSubscriptionArn,
          );
          if (yield* hasAlchemyTags(id, tags)) return subscription;
        }
        return undefined;
      });

      const toAttrs = (subscription: mm.AddonSubscription) =>
        subscription.AddonSubscriptionId !== undefined &&
        subscription.AddonSubscriptionArn !== undefined &&
        subscription.AddonName !== undefined
          ? {
              addonSubscriptionId: subscription.AddonSubscriptionId,
              addonSubscriptionArn: subscription.AddonSubscriptionArn,
              addonName: subscription.AddonName,
            }
          : undefined;

      const observe = Effect.fn(function* (
        id: string,
        output: AddonSubscription["Attributes"] | undefined,
      ) {
        if (output?.addonSubscriptionId !== undefined) {
          const found = yield* getById(output.addonSubscriptionId);
          if (found !== undefined) {
            return {
              AddonSubscriptionId: output.addonSubscriptionId,
              AddonSubscriptionArn: found.AddonSubscriptionArn,
              AddonName: found.AddonName,
            } satisfies mm.AddonSubscription;
          }
        }
        return yield* findByAlchemyTags(id);
      });

      return AddonSubscription.Provider.of({
        stables: ["addonSubscriptionId", "addonSubscriptionArn", "addonName"],

        list: () =>
          listAll.pipe(
            Effect.map((subscriptions) =>
              subscriptions.flatMap((s) => {
                const attrs = toAttrs(s);
                return attrs === undefined ? [] : [attrs];
              }),
            ),
          ),

        read: Effect.fn(function* ({ id, output }) {
          const subscription = yield* observe(id, output);
          if (subscription === undefined) return undefined;
          const attrs = toAttrs(subscription);
          if (attrs === undefined) return undefined;
          const tags = yield* readMailManagerTags(attrs.addonSubscriptionArn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        // The Add On product is create-only — changing it replaces the
        // subscription.
        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          if (olds !== undefined && olds.addonName !== news.addonName) {
            return { action: "replace" } as const;
          }
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };

          // 1. OBSERVE — by cached id, falling back to an ownership-tag
          //    search.
          let subscription = yield* observe(id, output);

          // 2. ENSURE — create if missing; a Conflict (already subscribed)
          //    re-observes via the tag search.
          if (subscription === undefined) {
            yield* session.note(`subscribing to Add On ${news.addonName}`);
            const created = yield* mm
              .createAddonSubscription({
                AddonName: news.addonName,
                Tags: createTagsList(desiredTags),
              })
              .pipe(
                Effect.catchTag("ConflictException", () =>
                  Effect.succeed(undefined),
                ),
              );
            if (created !== undefined) {
              const found = yield* getById(created.AddonSubscriptionId);
              subscription = {
                AddonSubscriptionId: created.AddonSubscriptionId,
                AddonSubscriptionArn: found?.AddonSubscriptionArn,
                AddonName: found?.AddonName ?? news.addonName,
              };
            } else {
              subscription = yield* findByAlchemyTags(id);
            }
          }
          const attrs =
            subscription !== undefined ? toAttrs(subscription) : undefined;
          if (attrs === undefined) {
            return yield* Effect.fail(
              new Error(
                `Mail Manager Add On subscription for '${news.addonName}' not found after create`,
              ),
            );
          }

          // 3. SYNC — only tags are mutable.
          yield* syncMailManagerTags(attrs.addonSubscriptionArn, desiredTags);

          yield* session.note(attrs.addonSubscriptionId);
          return attrs;
        }),

        delete: Effect.fn(function* ({ output }) {
          // DeleteAddonSubscription is natively idempotent — deleting a
          // nonexistent subscription succeeds (verified live).
          yield* mm
            .deleteAddonSubscription({
              AddonSubscriptionId: output.addonSubscriptionId,
            })
            .pipe(Effect.asVoid);
        }),
      });
    }),
  );
