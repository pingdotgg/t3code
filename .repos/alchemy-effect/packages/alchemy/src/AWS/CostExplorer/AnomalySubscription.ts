import * as ce from "@distilled.cloud/aws/cost-explorer";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import { fetchCeTags, pinCe, syncCeTags, toResourceTags } from "./common.ts";

/**
 * A subscriber notified when a monitored anomaly crosses the subscription's
 * threshold.
 */
export interface AnomalySubscriber {
  /**
   * The destination — an email address (for `EMAIL`) or an SNS topic ARN
   * (for `SNS`).
   */
  address: string;
  /**
   * How the subscriber is notified. `IMMEDIATE` frequency requires `SNS`
   * subscribers; `DAILY`/`WEEKLY` require `EMAIL`.
   */
  type: "EMAIL" | "SNS" | (string & {});
}

export interface AnomalySubscriptionProps {
  /**
   * Name of the subscription. If omitted, a unique name is generated from
   * the app, stage, and logical ID. Renaming updates the subscription in
   * place.
   */
  subscriptionName?: string;
  /**
   * ARNs of the anomaly monitors this subscription listens to. Pass
   * `monitor.monitorArn` outputs from {@link AnomalyMonitor} resources.
   */
  monitorArnList: string[];
  /**
   * Who gets notified when an anomaly crosses the threshold.
   */
  subscribers: AnomalySubscriber[];
  /**
   * How often notifications are sent. `IMMEDIATE` requires SNS subscribers;
   * `DAILY` and `WEEKLY` send email digests.
   */
  frequency: "DAILY" | "IMMEDIATE" | "WEEKLY" | (string & {});
  /**
   * An expression gating notifications on anomaly impact — e.g. only alert
   * when the total absolute impact exceeds $100:
   * `{ Dimensions: { Key: "ANOMALY_TOTAL_IMPACT_ABSOLUTE", MatchOptions: ["GREATER_THAN_OR_EQUAL"], Values: ["100"] } }`
   * (raw Cost Explorer `Expression` shape).
   */
  thresholdExpression?: ce.Expression;
  /**
   * User-defined tags to apply to the subscription.
   */
  tags?: Record<string, string>;
}

export interface AnomalySubscription extends Resource<
  "AWS.CostExplorer.AnomalySubscription",
  AnomalySubscriptionProps,
  {
    /** ARN of the anomaly subscription. */
    subscriptionArn: string;
    /** Name of the anomaly subscription. */
    subscriptionName: string;
    /** Account ID the subscription belongs to. */
    accountId: string | undefined;
    /** Current tags on the subscription. */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A Cost Explorer anomaly alert subscription. Attaches email or SNS
 * subscribers to one or more {@link AnomalyMonitor}s with a notification
 * frequency and an impact threshold.
 *
 * Cost Explorer is a global service — all calls are pinned to `us-east-1`
 * regardless of the stack region. Every property is mutable in place.
 *
 * @resource
 * @section Creating Anomaly Subscriptions
 * @example Daily email digest for anomalies over $100
 * ```typescript
 * import * as CostExplorer from "alchemy/AWS/CostExplorer";
 *
 * const monitor = yield* CostExplorer.AnomalyMonitor("ServiceSpend", {
 *   monitorType: "DIMENSIONAL",
 *   monitorDimension: "SERVICE",
 * });
 *
 * const subscription = yield* CostExplorer.AnomalySubscription("Alerts", {
 *   monitorArnList: [monitor.monitorArn],
 *   frequency: "DAILY",
 *   subscribers: [{ type: "EMAIL", address: "team@example.com" }],
 *   thresholdExpression: {
 *     Dimensions: {
 *       Key: "ANOMALY_TOTAL_IMPACT_ABSOLUTE",
 *       MatchOptions: ["GREATER_THAN_OR_EQUAL"],
 *       Values: ["100"],
 *     },
 *   },
 * });
 * ```
 *
 * @example Immediate SNS notifications
 * ```typescript
 * const subscription = yield* CostExplorer.AnomalySubscription("PagerFeed", {
 *   monitorArnList: [monitor.monitorArn],
 *   frequency: "IMMEDIATE",
 *   subscribers: [{ type: "SNS", address: topic.topicArn }],
 * });
 * ```
 */
export const AnomalySubscription = Resource<AnomalySubscription>(
  "AWS.CostExplorer.AnomalySubscription",
);

const sameStringSets = (l: readonly string[], r: readonly string[]) =>
  l.length === r.length &&
  [...l].sort().join("\n") === [...r].sort().join("\n");

export const AnomalySubscriptionProvider = () =>
  Provider.effect(
    AnomalySubscription,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: { subscriptionName?: string | undefined },
      ) {
        return (
          props.subscriptionName ??
          (yield* createPhysicalName({ id, maxLength: 100 }))
        );
      });

      const getByArn = (subscriptionArn: string) =>
        pinCe(
          ce.getAnomalySubscriptions({
            SubscriptionArnList: [subscriptionArn],
          }),
        ).pipe(
          Effect.map((r) => r.AnomalySubscriptions[0]),
          Effect.catchTag("UnknownSubscriptionException", () =>
            Effect.succeed(undefined),
          ),
        );

      const findByName = (subscriptionName: string) =>
        pinCe(
          ce.getAnomalySubscriptions.items({}).pipe(
            Stream.filter((s) => s.SubscriptionName === subscriptionName),
            Stream.take(1),
            Stream.runCollect,
          ),
        ).pipe(Effect.map((chunk) => Array.from(chunk)[0]));

      const toAttrs = Effect.fn(function* (live: ce.AnomalySubscription) {
        const subscriptionArn = live.SubscriptionArn!;
        return {
          subscriptionArn,
          subscriptionName: live.SubscriptionName,
          accountId: live.AccountId,
          tags: yield* fetchCeTags(subscriptionArn),
        };
      });

      const toSubscribers = (
        subscribers: AnomalySubscriber[],
      ): ce.Subscriber[] =>
        subscribers.map((s) => ({ Address: s.address, Type: s.type }));

      return AnomalySubscription.Provider.of({
        stables: ["subscriptionArn", "accountId"],
        list: () =>
          Effect.gen(function* () {
            const subscriptions = yield* pinCe(
              ce.getAnomalySubscriptions.items({}).pipe(Stream.runCollect),
            ).pipe(Effect.map((chunk) => Array.from(chunk)));
            return yield* Effect.forEach(
              subscriptions.filter((s) => s.SubscriptionArn !== undefined),
              toAttrs,
              { concurrency: 10 },
            );
          }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const live = output?.subscriptionArn
            ? yield* getByArn(output.subscriptionArn)
            : yield* findByName(yield* createName(id, olds ?? {}));
          if (live?.SubscriptionArn === undefined) return undefined;
          const attrs = yield* toAttrs(live);
          return (yield* hasAlchemyTags(id, attrs.tags))
            ? attrs
            : Unowned(attrs);
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = yield* createName(id, news);
          const internalTags = yield* createInternalTags(id);
          const desiredTags: Record<string, string> = {
            ...news.tags,
            ...internalTags,
          };
          const desiredSubscribers = toSubscribers(news.subscribers);

          // OBSERVE — cloud state is authoritative.
          const live = output?.subscriptionArn
            ? yield* getByArn(output.subscriptionArn)
            : yield* findByName(name);

          let subscriptionArn: string;
          if (live?.SubscriptionArn === undefined) {
            // ENSURE — create if missing. Subscription names are unique per
            // account; tolerate the AlreadyExists race by adopting the
            // same-name subscription and converging it (every property is
            // mutable via UpdateAnomalySubscription).
            const created = yield* pinCe(
              ce.createAnomalySubscription({
                AnomalySubscription: {
                  SubscriptionName: name,
                  MonitorArnList: news.monitorArnList,
                  Subscribers: desiredSubscribers,
                  Frequency: news.frequency,
                  ThresholdExpression: news.thresholdExpression,
                },
                ResourceTags: toResourceTags(desiredTags),
              }),
            ).pipe(
              Effect.catchTag("AnomalySubscriptionAlreadyExists", (error) =>
                Effect.gen(function* () {
                  const existing = yield* findByName(name);
                  const existingArn = existing?.SubscriptionArn;
                  if (existingArn === undefined) {
                    return yield* Effect.fail(error);
                  }
                  return yield* pinCe(
                    ce.updateAnomalySubscription({
                      SubscriptionArn: existingArn,
                      SubscriptionName: name,
                      MonitorArnList: news.monitorArnList,
                      Subscribers: desiredSubscribers,
                      Frequency: news.frequency,
                      ThresholdExpression: news.thresholdExpression,
                    }),
                  );
                }),
              ),
            );
            subscriptionArn = created.SubscriptionArn;
          } else {
            // SYNC — diff observed against desired; every field is mutable.
            subscriptionArn = live.SubscriptionArn;
            const observed = live;
            const needsUpdate =
              observed.SubscriptionName !== name ||
              observed.Frequency !== news.frequency ||
              !sameStringSets(observed.MonitorArnList, news.monitorArnList) ||
              !sameStringSets(
                observed.Subscribers.map((s) => `${s.Type}:${s.Address}`),
                desiredSubscribers.map((s) => `${s.Type}:${s.Address}`),
              ) ||
              (news.thresholdExpression !== undefined &&
                JSON.stringify(observed.ThresholdExpression) !==
                  JSON.stringify(news.thresholdExpression));
            if (needsUpdate) {
              yield* pinCe(
                ce.updateAnomalySubscription({
                  SubscriptionArn: subscriptionArn,
                  SubscriptionName: name,
                  MonitorArnList: news.monitorArnList,
                  Subscribers: desiredSubscribers,
                  Frequency: news.frequency,
                  ThresholdExpression: news.thresholdExpression,
                }),
              );
            }
          }

          // SYNC TAGS — diff against observed cloud tags.
          yield* syncCeTags(subscriptionArn, desiredTags);

          yield* session.note(subscriptionArn);
          const final = yield* getByArn(subscriptionArn);
          return {
            subscriptionArn,
            subscriptionName: name,
            accountId: final?.AccountId,
            tags: desiredTags,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* pinCe(
            ce.deleteAnomalySubscription({
              SubscriptionArn: output.subscriptionArn,
            }),
          ).pipe(
            Effect.catchTag("UnknownSubscriptionException", () => Effect.void),
          );
        }),
      });
    }),
  );
