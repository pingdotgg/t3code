import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as queues from "@distilled.cloud/cloudflare/queues";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// The scoped API token the test harness mints propagates eventually-
// consistently across Cloudflare's edge — ride out 403 blips
// (`Forbidden`, declared in the distilled error union) on the test's
// own out-of-band verification calls.
const getSubscription = (accountId: string, subscriptionId: string) =>
  queues.getSubscription({ accountId, subscriptionId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: Schedule.fixed("500 millis"),
      times: 20,
    }),
  );

const expectGone = (accountId: string, subscriptionId: string) =>
  getSubscription(accountId, subscriptionId).pipe(
    Effect.flatMap(() =>
      Effect.fail({ _tag: "SubscriptionNotDeleted" } as const),
    ),
    // A missing subscription surfaces as `SubscriptionNotFound`
    // (HTTP 404 "No subscription with this ID") — that's the success
    // condition here.
    Effect.catchTag("SubscriptionNotFound", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "SubscriptionNotDeleted",
      schedule: Schedule.max([
        Schedule.fixed("500 millis"),
        Schedule.recurs(20),
      ]),
    }),
  );

// Sequential: Cloudflare allows only ONE subscription per source per
// account, and every test here uses the same `{ type: "r2" }` (or kv)
// source. Run concurrently they adopt/patch/delete each other's
// subscription via the AlreadyExists fallback and fail with queueId
// mismatches and SubscriptionNotFound.
describe.sequential("Subscription", () => {
  test.provider(
    "create r2 event subscription into a queue and destroy it",
    (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;

        yield* stack.destroy();

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const queue = yield* Cloudflare.Queues.Queue("SubQueue", {
              name: "alchemy-test-sub-queue",
            });
            // Compose with an R2 bucket — the subscription delivers
            // account-level R2 events (e.g. this bucket's lifecycle)
            // into the queue.
            const bucket = yield* Cloudflare.R2.Bucket("SubBucket", {
              name: "alchemy-test-sub-bucket",
            });
            const subscription = yield* Cloudflare.Queues.Subscription(
              "R2Events",
              {
                source: { type: "r2" },
                events: ["bucket.created", "bucket.deleted"],
                queueId: queue.queueId,
              },
            );
            return { queue, bucket, subscription };
          }),
        );

        const sub = deployed.subscription;
        expect(sub.subscriptionId).toBeDefined();
        expect(sub.accountId).toEqual(accountId);
        expect(sub.source).toEqual({ type: "r2" });
        expect([...sub.events].sort()).toEqual([
          "bucket.created",
          "bucket.deleted",
        ]);
        expect(sub.enabled).toBe(true);
        expect(sub.queueId).toEqual(deployed.queue.queueId);

        // Out-of-band verification straight against the API.
        const live = yield* getSubscription(accountId, sub.subscriptionId);
        expect(live.id).toEqual(sub.subscriptionId);
        expect(live.destination.queueId).toEqual(deployed.queue.queueId);
        expect([...live.events].sort()).toEqual([
          "bucket.created",
          "bucket.deleted",
        ]);
        expect(live.enabled).toBe(true);

        yield* stack.destroy();

        yield* expectGone(accountId, sub.subscriptionId);
      }).pipe(logLevel),
  );

  test.provider(
    "update mutable props in place (same subscriptionId)",
    (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;

        yield* stack.destroy();

        const initial = yield* stack.deploy(
          Effect.gen(function* () {
            const queueA = yield* Cloudflare.Queues.Queue("SubQueueA", {
              name: "alchemy-test-sub-queue-a",
            });
            const queueB = yield* Cloudflare.Queues.Queue("SubQueueB", {
              name: "alchemy-test-sub-queue-b",
            });
            const subscription = yield* Cloudflare.Queues.Subscription(
              "UpdateSub",
              {
                name: "alchemy-sub-update",
                source: { type: "r2" },
                events: ["bucket.created"],
                queueId: queueA.queueId,
              },
            );
            return { queueA, queueB, subscription };
          }),
        );

        expect(initial.subscription.name).toEqual("alchemy-sub-update");
        expect(initial.subscription.enabled).toBe(true);
        expect(initial.subscription.queueId).toEqual(initial.queueA.queueId);

        // Mutate everything mutable: name, events, enabled, and the
        // destination queue.
        const updated = yield* stack.deploy(
          Effect.gen(function* () {
            const queueA = yield* Cloudflare.Queues.Queue("SubQueueA", {
              name: "alchemy-test-sub-queue-a",
            });
            const queueB = yield* Cloudflare.Queues.Queue("SubQueueB", {
              name: "alchemy-test-sub-queue-b",
            });
            const subscription = yield* Cloudflare.Queues.Subscription(
              "UpdateSub",
              {
                name: "alchemy-sub-update-v2",
                source: { type: "r2" },
                events: ["bucket.created", "bucket.deleted"],
                queueId: queueB.queueId,
                enabled: false,
              },
            );
            return { queueA, queueB, subscription };
          }),
        );

        // Same subscription mutated in place — not a replacement.
        expect(updated.subscription.subscriptionId).toEqual(
          initial.subscription.subscriptionId,
        );
        expect(updated.subscription.name).toEqual("alchemy-sub-update-v2");
        expect(updated.subscription.enabled).toBe(false);
        expect(updated.subscription.queueId).toEqual(updated.queueB.queueId);
        expect([...updated.subscription.events].sort()).toEqual([
          "bucket.created",
          "bucket.deleted",
        ]);

        const live = yield* getSubscription(
          accountId,
          updated.subscription.subscriptionId,
        );
        expect(live.name).toEqual("alchemy-sub-update-v2");
        expect(live.enabled).toBe(false);
        expect(live.destination.queueId).toEqual(updated.queueB.queueId);
        expect([...live.events].sort()).toEqual([
          "bucket.created",
          "bucket.deleted",
        ]);

        yield* stack.destroy();

        yield* expectGone(accountId, updated.subscription.subscriptionId);
      }).pipe(logLevel),
  );

  test.provider("replaces the subscription when the source changes", (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          const queue = yield* Cloudflare.Queues.Queue("SubQueueR", {
            name: "alchemy-test-sub-queue-r",
          });
          const subscription = yield* Cloudflare.Queues.Subscription(
            "ReplaceSub",
            {
              source: { type: "kv" },
              events: ["namespace.created"],
              queueId: queue.queueId,
            },
          );
          return { queue, subscription };
        }),
      );

      expect(initial.subscription.source).toEqual({ type: "kv" });

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          const queue = yield* Cloudflare.Queues.Queue("SubQueueR", {
            name: "alchemy-test-sub-queue-r",
          });
          const subscription = yield* Cloudflare.Queues.Subscription(
            "ReplaceSub",
            {
              source: { type: "r2" },
              events: ["bucket.created"],
              queueId: queue.queueId,
            },
          );
          return { queue, subscription };
        }),
      );

      // The source is fixed at creation — changing it produces a new
      // subscription identity.
      expect(replaced.subscription.subscriptionId).not.toEqual(
        initial.subscription.subscriptionId,
      );
      expect(replaced.subscription.source).toEqual({ type: "r2" });

      // The old subscription is gone after the replacement settles.
      yield* expectGone(accountId, initial.subscription.subscriptionId);

      const live = yield* getSubscription(
        accountId,
        replaced.subscription.subscriptionId,
      );
      expect(live.events).toEqual(["bucket.created"]);

      yield* stack.destroy();

      yield* expectGone(accountId, replaced.subscription.subscriptionId);
    }).pipe(logLevel),
  );

  // Canonical `list()` test (account collection): deploy a subscription,
  // then enumerate every subscription in the account via the typed provider
  // and assert the deployed one is present in the exhaustively-paginated
  // result.
  test.provider("list enumerates the deployed subscription", (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const queue = yield* Cloudflare.Queues.Queue("ListSubQueue", {
            name: "alchemy-test-list-sub-queue",
          });
          const subscription = yield* Cloudflare.Queues.Subscription(
            "ListR2Events",
            {
              source: { type: "r2" },
              events: ["bucket.created"],
              queueId: queue.queueId,
            },
          );
          return { queue, subscription };
        }),
      );

      const provider = yield* Provider.findProvider(
        Cloudflare.Queues.Subscription,
      );
      const all = yield* provider.list();

      expect(
        all.some(
          (s) => s.subscriptionId === deployed.subscription.subscriptionId,
        ),
      ).toBe(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  );
});
