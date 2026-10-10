import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as pubsublite from "@distilled.cloud/gcp/pubsublite_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  logLevel,
  currentProject,
  runLifecycle,
  waitUntilGone,
  zone,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

test.provider(
  "getAdminProjectsLocationsSubscriptions on a missing subscription fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        pubsublite.getAdminProjectsLocationsSubscriptions({
          name: `projects/${project}/locations/${zone}/subscriptions/alchemy-missing-subscription`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:pubsublite", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a subscription",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const topic = yield* GCP.PubSubLite.AdminTopic("Events", {
            location: zone,
          });
          const subscription = yield* GCP.PubSubLite.AdminSubscription(
            "Inbox",
            {
              location: zone,
              topic: topic.name,
              deliveryConfig: {
                deliveryRequirement: "DELIVER_IMMEDIATELY",
              },
            },
          );
          return { topic, subscription };
        }),
      );

      expect(created.subscription.name).toContain("/subscriptions/");
      expect(created.subscription.subscriptionId).toContain("+alc.");
      expect(created.subscription.location).toEqual(zone);
      expect(created.subscription.topic).toEqual(created.topic.name);
      expect(created.subscription.deliveryConfig?.deliveryRequirement).toEqual(
        "DELIVER_IMMEDIATELY",
      );

      const fetched = yield* pubsublite.getAdminProjectsLocationsSubscriptions({
        name: created.subscription.name,
      });
      expect(fetched.name).toEqual(created.subscription.name);
      expect(fetched.topic).toEqual(created.topic.name);
      expect(fetched.deliveryConfig?.deliveryRequirement).toEqual(
        "DELIVER_IMMEDIATELY",
      );

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const topic = yield* GCP.PubSubLite.AdminTopic("Events", {
            topicId: created.topic.topicId,
            location: zone,
          });
          const subscription = yield* GCP.PubSubLite.AdminSubscription(
            "Inbox",
            {
              subscriptionId: created.subscription.subscriptionId,
              location: zone,
              topic: topic.name,
              deliveryConfig: {
                deliveryRequirement: "DELIVER_AFTER_STORED",
              },
            },
          );
          return { topic, subscription };
        }),
      );

      expect(updated.subscription.name).toEqual(created.subscription.name);
      expect(updated.subscription.deliveryConfig?.deliveryRequirement).toEqual(
        "DELIVER_AFTER_STORED",
      );

      const refetched =
        yield* pubsublite.getAdminProjectsLocationsSubscriptions({
          name: created.subscription.name,
        });
      expect(refetched.deliveryConfig?.deliveryRequirement).toEqual(
        "DELIVER_AFTER_STORED",
      );

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        pubsublite.getAdminProjectsLocationsSubscriptions({
          name: created.subscription.name,
        }),
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:pubsublite", "live"],
    timeout: 90_000,
  },
);
