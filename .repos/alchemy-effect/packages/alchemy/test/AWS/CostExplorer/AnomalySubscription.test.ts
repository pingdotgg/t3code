import * as AWS from "@/AWS";
import { AnomalyMonitor } from "@/AWS/CostExplorer/AnomalyMonitor.ts";
import { AnomalySubscription } from "@/AWS/CostExplorer/AnomalySubscription.ts";
import * as Test from "@/Test/Alchemy";
import { Region as AwsRegion } from "@distilled.cloud/aws/Region";
import * as ce from "@distilled.cloud/aws/cost-explorer";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// Cost Explorer is served exclusively from us-east-1.
const pin = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provideService(AwsRegion, Effect.succeed("us-east-1")));

const subscriptionName = "alchemy-test-anomaly-subscription";

const getSubscription = (subscriptionArn: string) =>
  pin(
    ce.getAnomalySubscriptions({ SubscriptionArnList: [subscriptionArn] }),
  ).pipe(
    Effect.map((r) => r.AnomalySubscriptions[0]),
    Effect.catchTag("UnknownSubscriptionException", () =>
      Effect.succeed(undefined),
    ),
  );

// Typed wait-until-gone on delete.
const assertSubscriptionGone = (subscriptionArn: string) =>
  Effect.gen(function* () {
    const found = yield* getSubscription(subscriptionArn);
    if (found !== undefined) {
      return yield* Effect.fail(
        new Error(`subscription '${subscriptionArn}' still exists`),
      );
    }
  }).pipe(
    Effect.retry({
      schedule: Schedule.max([Schedule.fixed("2 seconds"), Schedule.recurs(5)]),
    }),
  );

const makeStack = (frequency: "DAILY" | "WEEKLY", impactThreshold: string) =>
  Effect.gen(function* () {
    const monitor = yield* AnomalyMonitor("SubMonitor", {
      monitorName: "alchemy-test-subscription-monitor",
      monitorType: "CUSTOM",
      monitorSpecification: {
        Tags: { Key: "CostCenter", Values: ["alchemy-test-sub"] },
      },
    });
    const subscription = yield* AnomalySubscription("Subscription", {
      subscriptionName,
      monitorArnList: [monitor.monitorArn],
      frequency,
      subscribers: [{ type: "EMAIL", address: "anomaly-test@example.com" }],
      thresholdExpression: {
        Dimensions: {
          Key: "ANOMALY_TOTAL_IMPACT_ABSOLUTE",
          MatchOptions: ["GREATER_THAN_OR_EQUAL"],
          Values: [impactThreshold],
        },
      },
      tags: { fixture: "cost-explorer-anomaly-subscription" },
    });
    return {
      monitorArn: monitor.monitorArn,
      subscriptionArn: subscription.subscriptionArn,
    };
  });

test.provider(
  "lifecycle: create subscription on a monitor, update frequency + threshold, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(makeStack("DAILY", "100"));

      // Out-of-band verification via distilled.
      const created = yield* getSubscription(deployed.subscriptionArn);
      expect(created?.SubscriptionName).toBe(subscriptionName);
      expect(created?.Frequency).toBe("DAILY");
      expect(created?.MonitorArnList).toEqual([deployed.monitorArn]);
      expect(created?.Subscribers[0]?.Address).toBe("anomaly-test@example.com");
      expect(created?.Subscribers[0]?.Type).toBe("EMAIL");

      // Update — frequency and threshold expression are mutable in place.
      const updated = yield* stack.deploy(makeStack("WEEKLY", "250"));
      expect(updated.subscriptionArn).toBe(deployed.subscriptionArn);
      const afterUpdate = yield* getSubscription(deployed.subscriptionArn);
      expect(afterUpdate?.Frequency).toBe("WEEKLY");
      expect(afterUpdate?.ThresholdExpression?.Dimensions?.Values).toEqual([
        "250",
      ]);

      // Destroy — subscription and monitor are gone.
      yield* stack.destroy();
      yield* assertSubscriptionGone(deployed.subscriptionArn);
    }),
  { timeout: 120_000 },
);
