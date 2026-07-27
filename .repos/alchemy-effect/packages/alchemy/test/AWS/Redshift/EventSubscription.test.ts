import * as AWS from "@/AWS";
import { EventSubscription } from "@/AWS/Redshift";
import * as SNS from "@/AWS/SNS";
import * as Test from "@/Test/Alchemy";
import * as redshift from "@distilled.cloud/aws/redshift";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probe: proves the distilled error union carries the
// not-found tag this provider's read/delete paths depend on.
test.provider(
  "describeEventSubscriptions on a nonexistent subscription fails with SubscriptionNotFoundFault",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        redshift.describeEventSubscriptions({
          SubscriptionName: "alchemy-nonexistent-redshift-sub-probe",
        }),
      );
      expect(error._tag).toBe("SubscriptionNotFoundFault");
    }),
);

const readSubscription = (name: string) =>
  Effect.gen(function* () {
    const response = yield* redshift.describeEventSubscriptions({
      SubscriptionName: name,
    });
    return response.EventSubscriptionsList?.[0];
  });

test.provider(
  "create with filters, update filters in place, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Create — an SNS topic plus a subscription filtered to cluster
      // monitoring/management events. Subscriptions are free and instant.
      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const topic = yield* SNS.Topic("Alerts", {});
          return yield* EventSubscription("Events", {
            snsTopicArn: topic.topicArn,
            sourceType: "cluster",
            eventCategories: ["monitoring", "management"],
            severity: "INFO",
            tags: { fixture: "redshift-event-subscription" },
          });
        }),
      );

      expect(created.subscriptionName).toBeDefined();
      expect(created.eventSubscriptionArn).toContain(":eventsubscription:");
      expect(created.sourceType).toBe("cluster");
      expect([...created.eventCategories].sort()).toEqual([
        "management",
        "monitoring",
      ]);
      expect(created.severity).toBe("INFO");
      expect(created.enabled).toBe(true);
      expect(created.snsTopicArn).toContain(":sns:");

      // Out-of-band verification via distilled.
      const observed = yield* readSubscription(created.subscriptionName);
      expect(observed?.Status).toBe("active");
      expect(observed?.SourceType).toBe("cluster");
      expect(
        observed?.Tags?.some(
          (t) =>
            t.Key === "fixture" && t.Value === "redshift-event-subscription",
        ),
      ).toBe(true);

      // Update — narrow the categories, flip severity, disable delivery.
      // Same name, so it must modify in place.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const topic = yield* SNS.Topic("Alerts", {});
          return yield* EventSubscription("Events", {
            snsTopicArn: topic.topicArn,
            sourceType: "cluster",
            eventCategories: ["monitoring"],
            severity: "ERROR",
            enabled: false,
            tags: { fixture: "redshift-event-subscription" },
          });
        }),
      );

      expect(updated.subscriptionName).toBe(created.subscriptionName);
      expect(updated.eventCategories).toEqual(["monitoring"]);
      expect(updated.severity).toBe("ERROR");
      expect(updated.enabled).toBe(false);

      const reobserved = yield* readSubscription(created.subscriptionName);
      expect(reobserved?.EventCategoriesList).toEqual(["monitoring"]);
      expect(reobserved?.Severity).toBe("ERROR");
      expect(reobserved?.Enabled).toBe(false);

      // Destroy and verify gone with the typed not-found tag.
      yield* stack.destroy();
      const error = yield* Effect.flip(
        redshift.describeEventSubscriptions({
          SubscriptionName: created.subscriptionName,
        }),
      );
      expect(error._tag).toBe("SubscriptionNotFoundFault");
    }),
  { timeout: 180_000 },
);
