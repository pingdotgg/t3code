import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as r2 from "@distilled.cloud/cloudflare/r2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// The scoped API token the test harness mints propagates eventually-
// consistently across Cloudflare's edge — ride out 403 blips (`Forbidden`,
// declared in the distilled error union) on out-of-band verification calls.
const getNotification = (
  accountId: string,
  bucketName: string,
  queueId: string,
) =>
  r2.getBucketEventNotification({ accountId, bucketName, queueId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: Schedule.exponential("500 millis"),
      times: 8,
    }),
  );

// A deleted configuration surfaces as `EventNotificationConfigNotFound`
// (code 11011) or `NoEventNotificationConfig` (code 11015) — and once the
// stack's bucket/queue are destroyed, as `BucketNotFound`/`QueueNotFound`.
// All of those are the success condition here.
const expectGone = (accountId: string, bucketName: string, queueId: string) =>
  getNotification(accountId, bucketName, queueId).pipe(
    Effect.flatMap(() =>
      Effect.fail({ _tag: "NotificationNotDeleted" } as const),
    ),
    Effect.catchTag(
      [
        "NoEventNotificationConfig",
        "EventNotificationConfigNotFound",
        "BucketNotFound",
        "QueueNotFound",
      ],
      () => Effect.void,
    ),
    Effect.retry({
      while: (e) => e._tag === "NotificationNotDeleted",
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(10),
      ]),
    }),
  );

// One program deploying the bucket, the queue, and the notification joining
// them. The notification's props reference both resources' outputs, so the
// engine orders notification-last on deploy (and first on destroy).
const program = (opts: {
  rules: Cloudflare.R2.BucketEventNotificationRule[];
}) =>
  Effect.gen(function* () {
    const bucket = yield* Cloudflare.R2.Bucket("EventBucket");
    const queue = yield* Cloudflare.Queues.Queue("EventQueueA");
    const notification = yield* Cloudflare.R2.BucketEventNotification(
      "Notification",
      {
        bucketName: bucket.bucketName,
        queueId: queue.queueId,
        rules: opts.rules,
      },
    );
    return { bucket, queue, notification };
  });

// Replacement variant — both queues stay deployed across both steps; only
// the notification's target queue flips, so the replacement is isolated to
// the notification itself.
const replacementProgram = (opts: {
  rules: Cloudflare.R2.BucketEventNotificationRule[];
  target: "A" | "B";
}) =>
  Effect.gen(function* () {
    const bucket = yield* Cloudflare.R2.Bucket("EventBucket");
    const queueA = yield* Cloudflare.Queues.Queue("EventQueueA");
    const queueB = yield* Cloudflare.Queues.Queue("EventQueueB");
    const target = opts.target === "B" ? queueB : queueA;
    const notification = yield* Cloudflare.R2.BucketEventNotification(
      "Notification",
      {
        bucketName: bucket.bucketName,
        queueId: target.queueId,
        rules: opts.rules,
      },
    );
    return { bucket, queueA, queueB, notification };
  });

test.provider(
  "create, update rules in place, and delete",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      // Create — a single prefix-scoped rule.
      const initial = yield* stack.deploy(
        program({
          rules: [
            {
              actions: ["PutObject", "DeleteObject"],
              prefix: "incoming/",
            },
          ],
        }),
      );

      expect(initial.notification.accountId).toEqual(accountId);
      expect(initial.notification.bucketName).toEqual(
        initial.bucket.bucketName,
      );
      expect(initial.notification.queueId).toEqual(initial.queue.queueId);
      expect(initial.notification.jurisdiction).toEqual("default");
      expect(initial.notification.rules).toHaveLength(1);
      expect([...initial.notification.rules[0].actions].sort()).toEqual([
        "DeleteObject",
        "PutObject",
      ]);
      expect(initial.notification.rules[0].prefix).toEqual("incoming/");
      expect(initial.notification.rules[0].ruleId).toBeDefined();

      const live = yield* getNotification(
        accountId,
        initial.bucket.bucketName,
        initial.queue.queueId,
      );
      // The endpoint echoes the queue ID in dashed-UUID form.
      expect(live.queueId?.replace(/-/g, "")).toEqual(initial.queue.queueId);
      expect(live.rules ?? []).toHaveLength(1);
      expect(live.rules?.[0].prefix).toEqual("incoming/");

      // Update — replace the rule set in place (same bucket + queue pair).
      const updated = yield* stack.deploy(
        program({
          rules: [
            {
              actions: ["PutObject", "CompleteMultipartUpload"],
              prefix: "images/",
              suffix: ".png",
              description: "new PNG images",
            },
            {
              actions: ["DeleteObject", "LifecycleDeletion"],
              // R2 rejects rules whose key ranges overlap ("invalid
              // overlap"), even with disjoint actions — scope this rule
              // to a separate prefix.
              prefix: "logs/",
            },
          ],
        }),
      );

      // Same configuration mutated in place — not a replacement.
      expect(updated.notification.bucketName).toEqual(
        initial.notification.bucketName,
      );
      expect(updated.notification.queueId).toEqual(
        initial.notification.queueId,
      );
      expect(updated.notification.rules).toHaveLength(2);

      const liveUpdated = yield* getNotification(
        accountId,
        updated.bucket.bucketName,
        updated.queue.queueId,
      );
      const liveRules = [...(liveUpdated.rules ?? [])].sort((a, b) =>
        (a.prefix ?? "").localeCompare(b.prefix ?? ""),
      );
      expect(liveRules).toHaveLength(2);
      expect(liveRules[0].prefix).toEqual("images/");
      expect(liveRules[0].suffix).toEqual(".png");
      expect(liveRules[0].description).toEqual("new PNG images");
      expect(liveRules[1].prefix).toEqual("logs/");
      expect([...liveRules[1].actions].sort()).toEqual([
        "DeleteObject",
        "LifecycleDeletion",
      ]);

      // Redeploying identical props is a no-op (same rule IDs survive).
      const noop = yield* stack.deploy(
        program({
          rules: [
            {
              actions: ["PutObject", "CompleteMultipartUpload"],
              prefix: "images/",
              suffix: ".png",
              description: "new PNG images",
            },
            {
              actions: ["DeleteObject", "LifecycleDeletion"],
              // R2 rejects rules whose key ranges overlap ("invalid
              // overlap"), even with disjoint actions — scope this rule
              // to a separate prefix.
              prefix: "logs/",
            },
          ],
        }),
      );
      expect(noop.notification.rules.map((rule) => rule.ruleId).sort()).toEqual(
        updated.notification.rules.map((rule) => rule.ruleId).sort(),
      );

      yield* stack.destroy();

      yield* expectGone(
        accountId,
        initial.bucket.bucketName,
        initial.queue.queueId,
      );

      // Destroy again — delete must be idempotent (already gone).
      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 300_000 },
);

test.provider(
  "changing the queue triggers a replacement",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const initial = yield* stack.deploy(
        replacementProgram({
          target: "A",
          rules: [{ actions: ["PutObject"] }],
        }),
      );
      expect(initial.notification.queueId).toEqual(initial.queueA.queueId);

      // Point the notification at a different queue — the (bucket, queue)
      // pair is the configuration's identity, so this replaces it.
      const replaced = yield* stack.deploy(
        replacementProgram({
          target: "B",
          rules: [{ actions: ["PutObject"] }],
        }),
      );

      expect(replaced.queueB.queueId).not.toEqual(initial.queueA.queueId);
      expect(replaced.notification.queueId).toEqual(replaced.queueB.queueId);

      // The old pair's configuration is gone; the new pair's is live.
      yield* expectGone(
        accountId,
        initial.bucket.bucketName,
        initial.queueA.queueId,
      );
      const live = yield* getNotification(
        accountId,
        replaced.bucket.bucketName,
        replaced.queueB.queueId,
      );
      // The endpoint echoes the queue ID in dashed-UUID form.
      expect(live.queueId?.replace(/-/g, "")).toEqual(replaced.queueB.queueId);

      yield* stack.destroy();

      yield* expectGone(
        accountId,
        replaced.bucket.bucketName,
        replaced.queueB.queueId,
      );
    }).pipe(logLevel),
  { timeout: 300_000 },
);

test.provider(
  "list enumerates deployed bucket event notifications",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        program({
          rules: [
            { actions: ["PutObject", "DeleteObject"], prefix: "incoming/" },
          ],
        }),
      );

      // Parent fan-out over every R2 bucket, then each bucket's
      // event-notification queues — the deployed (bucket, queue) pair must
      // appear, hydrated into the exact `read` Attributes shape.
      const provider = yield* Provider.findProvider(
        Cloudflare.R2.BucketEventNotification,
      );
      const all = yield* provider.list();

      const found = all.find(
        (n) =>
          n.bucketName === deployed.bucket.bucketName &&
          n.queueId === deployed.queue.queueId,
      );
      expect(found).toBeDefined();
      expect(found?.accountId).toBeDefined();
      expect(found?.jurisdiction).toEqual("default");
      expect(found?.rules.length).toBeGreaterThanOrEqual(1);
      expect(found?.rules.some((rule) => rule.prefix === "incoming/")).toBe(
        true,
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 300_000 },
);
