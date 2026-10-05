import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as Core from "@/Test/Core";
import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import * as pubsublite from "@distilled.cloud/gcp/pubsublite_v1";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { dockerAvailable, expectProbe } from "../bindingHost.ts";
import { currentProject, runLifecycle } from "./common.ts";
import PubSubLiteBindingsHost, {
  COMMITTED_OFFSET,
  Capacity,
  Events,
  Inbox,
} from "./fixtures/bindings-host.ts";

const testOptions = { providers: GCP.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "PubSubLiteBindings");

let baseUrl: string;
let member: string;
let names: { topic: string; subscription: string; reservation: string };

/** `[role, condition]` pairs the host holds on the project. */
const hostProjectGrants = Effect.gen(function* () {
  const project = yield* currentProject;
  const policy = yield* resourcemanager.getIamPolicyProjects({
    resource: `projects/${project}`,
    body: { options: { requestedPolicyVersion: 3 } },
  });
  return (policy.bindings ?? [])
    .filter((binding) => (binding.members ?? []).includes(member))
    .map((binding) => [binding.role, binding.condition])
    .sort();
});

// Pub/Sub Lite has no resource-level IAM; its roles are granted on the
// project.
const expectedGrants = [
  ["roles/pubsublite.subscriber", undefined],
  ["roles/pubsublite.viewer", undefined],
];

// Pub/Sub Lite is turned down: creating a topic on the testing project
// answers 403 PERMISSION_DENIED "Pub/Sub Lite is deprecated and will be
// turned down in March 2026. New customers and existing customers who have
// not used Pub/Sub Lite within the 90-day period preceding September 24,
// 2024 ... will not be able to access the service" (reason
// DEPRECATED_FOR_UNUSED_CUSTOMERS, typed `PubSubLiteTurnedDown`). Only an
// allow-listed project can run this (GCP_TEST_PUBSUBLITE=1).
describe.skipIf(!dockerAvailable || !runLifecycle)(
  "PubSubLite Bindings",
  {
    tags: [
      "provider:gcp",
      "provider:gcp:pubsublite",
      "provider:gcp:run",
      "live",
    ],
  },
  () => {
    beforeAll(
      Effect.gen(function* () {
        yield* sharedStack.destroy();
        const out = yield* sharedStack.deploy(
          Effect.gen(function* () {
            const host = yield* PubSubLiteBindingsHost;
            return {
              uri: host.uri,
              serviceAccount: host.serviceAccount,
              topic: (yield* Events).name,
              subscription: (yield* Inbox).name,
              reservation: (yield* Capacity).name,
            };
          }),
        );
        baseUrl = out.uri!;
        member = `serviceAccount:${out.serviceAccount!}`;
        names = out;
      }),
      { timeout: 900_000 },
    );

    afterAll(sharedStack.destroy(), { timeout: 600_000 });

    describe("GetTopic", () => {
      test.provider(
        "reads the topic",
        (_stack) =>
          Effect.gen(function* () {
            const live = yield* expectProbe<pubsublite.Topic>(
              baseUrl,
              "getTopic",
            );
            expect(live.name).toEqual(names.topic);
            expect(yield* hostProjectGrants).toEqual(expectedGrants);
          }),
        { tags: ["provider:gcp", "provider:gcp:pubsublite", "live"] },
      );
    });

    describe("GetPartitions", () => {
      test.provider(
        "reads the partition count",
        (_stack) =>
          Effect.gen(function* () {
            const live = yield* expectProbe<pubsublite.TopicPartitions>(
              baseUrl,
              "getPartitions",
            );
            expect(live.partitionCount).toEqual("1");
            expect(yield* hostProjectGrants).toEqual(expectedGrants);
          }),
        { tags: ["provider:gcp", "provider:gcp:pubsublite", "live"] },
      );
    });

    describe("ComputeHeadCursor", () => {
      test.provider(
        "computes the head cursor of partition 0",
        (_stack) =>
          Effect.gen(function* () {
            const head =
              yield* expectProbe<pubsublite.ComputeHeadCursorResponse>(
                baseUrl,
                "computeHeadCursor",
              );
            expect(head.headCursor?.offset ?? "0").toEqual("0");
            expect(yield* hostProjectGrants).toEqual(expectedGrants);
          }),
        { tags: ["provider:gcp", "provider:gcp:pubsublite", "live"] },
      );
    });

    describe("GetSubscription", () => {
      test.provider(
        "reads the subscription",
        (_stack) =>
          Effect.gen(function* () {
            const live = yield* expectProbe<pubsublite.Subscription>(
              baseUrl,
              "getSubscription",
            );
            expect(live.name).toEqual(names.subscription);
            expect(live.topic).toEqual(names.topic);
            expect(yield* hostProjectGrants).toEqual(expectedGrants);
          }),
        { tags: ["provider:gcp", "provider:gcp:pubsublite", "live"] },
      );
    });

    describe("CommitCursor", () => {
      test.provider(
        "commits the partition 0 cursor",
        (_stack) =>
          Effect.gen(function* () {
            yield* expectProbe(baseUrl, "commitCursor");
            const cursors =
              yield* pubsublite.listCursorProjectsLocationsSubscriptionsCursors(
                {
                  parent: names.subscription,
                },
              );
            expect(
              (cursors.partitionCursors ?? []).map((cursor) => ({
                partition: cursor.partition,
                offset: cursor.cursor?.offset,
              })),
            ).toEqual([{ partition: "0", offset: COMMITTED_OFFSET }]);
            expect(yield* hostProjectGrants).toEqual(expectedGrants);
          }),
        { tags: ["provider:gcp", "provider:gcp:pubsublite", "live"] },
      );
    });

    describe("GetReservation", () => {
      test.provider(
        "reads the reservation",
        (_stack) =>
          Effect.gen(function* () {
            const live = yield* expectProbe<pubsublite.Reservation>(
              baseUrl,
              "getReservation",
            );
            expect(live.name).toEqual(names.reservation);
            expect(live.throughputCapacity).toEqual("4");
            expect(yield* hostProjectGrants).toEqual(expectedGrants);
          }),
        { tags: ["provider:gcp", "provider:gcp:pubsublite", "live"] },
      );
    });
  },
);
