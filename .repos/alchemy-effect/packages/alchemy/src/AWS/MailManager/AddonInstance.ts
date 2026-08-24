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

export interface AddonInstanceProps {
  /**
   * ID of the {@link AddonSubscription} this instance is created from.
   * Immutable — changing the subscription replaces the instance.
   */
  addonSubscriptionId: string;
  /**
   * Tags applied to the instance. Alchemy ownership tags are merged in
   * automatically.
   */
  tags?: Record<string, string>;
}

export interface AddonInstance extends Resource<
  "AWS.MailManager.AddonInstance",
  AddonInstanceProps,
  {
    /** Server-assigned ID of the Add On instance. */
    addonInstanceId: string;
    /** ARN of the Add On instance. */
    addonInstanceArn: string;
    /** ID of the subscription the instance was created from. */
    addonSubscriptionId: string;
    /** Name of the Add On product. */
    addonName: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An SES Mail Manager Add On instance — a usable deployment of a subscribed
 * Add On that rule-set conditions and traffic-policy statements reference as
 * an analyzer.
 *
 * Instances are immutable after creation (only tags update in place).
 * @resource
 * @section Creating Add On Instances
 * @example Instance from a Subscription
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
 *
 * @section Referencing from a Traffic Policy
 * @example Analyzer Condition
 * ```typescript
 * const policy = yield* MailManager.TrafficPolicy("Edge", {
 *   defaultAction: "ALLOW",
 *   policyStatements: [
 *     {
 *       Action: "DENY",
 *       Conditions: [
 *         {
 *           BooleanExpression: {
 *             Evaluate: {
 *               Analysis: {
 *                 Analyzer: instance.addonInstanceArn,
 *                 ResultField: "IN_DBL",
 *               },
 *             },
 *             Operator: "IS_TRUE",
 *           },
 *         },
 *       ],
 *     },
 *   ],
 * });
 * ```
 */
export const AddonInstance = Resource<AddonInstance>(
  "AWS.MailManager.AddonInstance",
);

export const AddonInstanceProvider = () =>
  Provider.effect(
    AddonInstance,
    Effect.gen(function* () {
      const getById = (addonInstanceId: string) =>
        mm
          .getAddonInstance({ AddonInstanceId: addonInstanceId })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );

      const listAll = mm.listAddonInstances.pages({}).pipe(
        Stream.runCollect,
        Effect.map((chunk) =>
          Array.from(chunk).flatMap((page) => page.AddonInstances ?? []),
        ),
      );

      // Instances have no user-supplied name — recover identity after a lost
      // state write by searching for our ownership tags.
      const findByAlchemyTags = Effect.fn(function* (id: string) {
        const instances = yield* listAll;
        for (const instance of instances) {
          if (instance.AddonInstanceArn === undefined) continue;
          const tags = yield* readMailManagerTags(instance.AddonInstanceArn);
          if (yield* hasAlchemyTags(id, tags)) return instance;
        }
        return undefined;
      });

      const toAttrs = (instance: mm.AddonInstance) =>
        instance.AddonInstanceId !== undefined &&
        instance.AddonInstanceArn !== undefined &&
        instance.AddonSubscriptionId !== undefined
          ? {
              addonInstanceId: instance.AddonInstanceId,
              addonInstanceArn: instance.AddonInstanceArn,
              addonSubscriptionId: instance.AddonSubscriptionId,
              addonName: instance.AddonName,
            }
          : undefined;

      const observe = Effect.fn(function* (
        id: string,
        output: AddonInstance["Attributes"] | undefined,
      ) {
        if (output?.addonInstanceId !== undefined) {
          const found = yield* getById(output.addonInstanceId);
          if (found !== undefined) {
            return {
              AddonInstanceId: output.addonInstanceId,
              AddonInstanceArn: found.AddonInstanceArn,
              AddonSubscriptionId: found.AddonSubscriptionId,
              AddonName: found.AddonName,
            } satisfies mm.AddonInstance;
          }
        }
        return yield* findByAlchemyTags(id);
      });

      return AddonInstance.Provider.of({
        stables: [
          "addonInstanceId",
          "addonInstanceArn",
          "addonSubscriptionId",
          "addonName",
        ],

        list: () =>
          listAll.pipe(
            Effect.map((instances) =>
              instances.flatMap((i) => {
                const attrs = toAttrs(i);
                return attrs === undefined ? [] : [attrs];
              }),
            ),
          ),

        read: Effect.fn(function* ({ id, output }) {
          const instance = yield* observe(id, output);
          if (instance === undefined) return undefined;
          const attrs = toAttrs(instance);
          if (attrs === undefined) return undefined;
          const tags = yield* readMailManagerTags(attrs.addonInstanceArn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        // The subscription is create-only — changing it replaces the
        // instance.
        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          if (
            olds !== undefined &&
            olds.addonSubscriptionId !== news.addonSubscriptionId
          ) {
            return { action: "replace" } as const;
          }
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };

          // 1. OBSERVE — by cached id, falling back to an ownership-tag
          //    search.
          let instance = yield* observe(id, output);

          // 2. ENSURE — create if missing; a Conflict race re-observes via
          //    the tag search.
          if (instance === undefined) {
            yield* session.note(
              `creating Add On instance for subscription ${news.addonSubscriptionId}`,
            );
            const created = yield* mm
              .createAddonInstance({
                AddonSubscriptionId: news.addonSubscriptionId,
                Tags: createTagsList(desiredTags),
              })
              .pipe(
                Effect.catchTag("ConflictException", () =>
                  Effect.succeed(undefined),
                ),
              );
            if (created !== undefined) {
              const found = yield* getById(created.AddonInstanceId);
              instance = {
                AddonInstanceId: created.AddonInstanceId,
                AddonInstanceArn: found?.AddonInstanceArn,
                AddonSubscriptionId:
                  found?.AddonSubscriptionId ?? news.addonSubscriptionId,
                AddonName: found?.AddonName,
              };
            } else {
              instance = yield* findByAlchemyTags(id);
            }
          }
          const attrs = instance !== undefined ? toAttrs(instance) : undefined;
          if (attrs === undefined) {
            return yield* Effect.fail(
              new Error(
                `Mail Manager Add On instance for subscription '${news.addonSubscriptionId}' not found after create`,
              ),
            );
          }

          // 3. SYNC — only tags are mutable.
          yield* syncMailManagerTags(attrs.addonInstanceArn, desiredTags);

          yield* session.note(attrs.addonInstanceId);
          return attrs;
        }),

        delete: Effect.fn(function* ({ output }) {
          // DeleteAddonInstance is natively idempotent — deleting a
          // nonexistent instance succeeds (verified live).
          yield* mm
            .deleteAddonInstance({ AddonInstanceId: output.addonInstanceId })
            .pipe(Effect.asVoid);
        }),
      });
    }),
  );
