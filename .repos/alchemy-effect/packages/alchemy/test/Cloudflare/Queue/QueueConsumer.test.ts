import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { State } from "@/State";
import * as Test from "@/Test/Vitest";
import * as queues from "@distilled.cloud/cloudflare/queues";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { MinimumLogLevel } from "effect/References";
import * as pathe from "pathe";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const main = pathe.resolve(import.meta.dirname, "consumer-worker.ts");

/**
 * Lifecycle: create the consumer, change settings (in-place update),
 * change script (replace), then destroy.
 *
 * Verifies the diff matrix end-to-end and that updateConsumer is
 * issued every reconcile (so settings drift gets corrected even when
 * `olds.settings` matches `news.settings`).
 */
test.provider("create, update settings, replace script, delete", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* CloudflareEnvironment;

    yield* stack.destroy();

    const initial = yield* stack.deploy(
      Effect.gen(function* () {
        const queue = yield* Cloudflare.Queue("Q");
        const workerA = yield* Cloudflare.Worker("WorkerA", {
          main,
          compatibility: { date: "2024-01-01" },
        });
        const consumer = yield* Cloudflare.QueueConsumer("Consumer", {
          queueId: queue.queueId,
          scriptName: workerA.workerName,
          settings: { batchSize: 5, maxRetries: 3 },
        });
        return { queue, workerA, consumer };
      }),
    );

    expect(initial.consumer.consumerId).toBeTypeOf("string");
    expect(initial.consumer.scriptName).toEqual(initial.workerA.workerName);

    const live = yield* queues.getConsumer({
      accountId,
      queueId: initial.queue.queueId,
      consumerId: initial.consumer.consumerId,
    });
    expect("scriptName" in live ? live.scriptName : undefined).toEqual(
      initial.workerA.workerName,
    );

    // Settings-only change is an update, not a replace — consumerId
    // must remain stable.
    const updated = yield* stack.deploy(
      Effect.gen(function* () {
        const queue = yield* Cloudflare.Queue("Q");
        const workerA = yield* Cloudflare.Worker("WorkerA", {
          main,
          compatibility: { date: "2024-01-01" },
        });
        const consumer = yield* Cloudflare.QueueConsumer("Consumer", {
          queueId: queue.queueId,
          scriptName: workerA.workerName,
          settings: { batchSize: 25, maxRetries: 7 },
        });
        return { queue, workerA, consumer };
      }),
    );

    expect(updated.consumer.consumerId).toEqual(initial.consumer.consumerId);

    const liveUpdated = yield* queues.getConsumer({
      accountId,
      queueId: updated.queue.queueId,
      consumerId: updated.consumer.consumerId,
    });
    expect(liveUpdated.settings?.batchSize).toEqual(25);
    expect(liveUpdated.settings?.maxRetries).toEqual(7);

    // Script change is a delete-first replace: Cloudflare's
    // updateConsumer silently ignores script_name on an existing
    // consumer, and the platform allows only one Worker consumer
    // per queue, so the engine must tear the old consumer down
    // before creating the new one. WorkerA stays yielded across
    // the deploy so it isn't garbage-collected mid-replace and
    // race the Worker.delete with Cloudflare's queue↔script sync.
    const replaced = yield* stack.deploy(
      Effect.gen(function* () {
        const queue = yield* Cloudflare.Queue("Q");
        yield* Cloudflare.Worker("WorkerA", {
          main,
          compatibility: { date: "2024-01-01" },
        });
        const workerB = yield* Cloudflare.Worker("WorkerB", {
          main,
          compatibility: { date: "2024-01-01" },
        });
        const consumer = yield* Cloudflare.QueueConsumer("Consumer", {
          queueId: queue.queueId,
          scriptName: workerB.workerName,
          settings: { batchSize: 25, maxRetries: 7 },
        });
        return { queue, workerB, consumer };
      }),
    );

    expect(replaced.consumer.consumerId).not.toEqual(
      initial.consumer.consumerId,
    );
    expect(replaced.consumer.scriptName).toEqual(replaced.workerB.workerName);

    const liveReplaced = yield* queues.getConsumer({
      accountId,
      queueId: replaced.queue.queueId,
      consumerId: replaced.consumer.consumerId,
    });
    expect(
      "scriptName" in liveReplaced ? liveReplaced.scriptName : undefined,
    ).toEqual(replaced.workerB.workerName);

    // The original consumer must be gone after the replace.
    const oldExit = yield* Effect.exit(
      queues.getConsumer({
        accountId,
        queueId: replaced.queue.queueId,
        consumerId: initial.consumer.consumerId,
      }),
    );
    expect(Exit.isFailure(oldExit)).toBe(true);

    yield* stack.destroy();

    // Post-destroy: the new consumer must be gone on Cloudflare too.
    const exit = yield* Effect.exit(
      queues.getConsumer({
        accountId,
        queueId: replaced.queue.queueId,
        consumerId: replaced.consumer.consumerId,
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  }).pipe(logLevel),
);

/**
 * Recovery from out-of-band consumer deletion. After a manual
 * `deleteConsumer` via the API, the reconciler must observe that
 * the consumer is missing and recreate it instead of failing on a
 * stale `output.consumerId` from local state.
 *
 * The redeploy bumps `settings` so the diff returns `update` and
 * the engine actually invokes reconcile (a no-prop redeploy is a
 * `noop` and skips drift detection by design — drift correction
 * only happens when something the user-controlled changes).
 */
test.provider("recreates consumer after out-of-band delete", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* CloudflareEnvironment;

    yield* stack.destroy();

    const initial = yield* stack.deploy(
      Effect.gen(function* () {
        const queue = yield* Cloudflare.Queue("Q");
        const worker = yield* Cloudflare.Worker("Worker", {
          main,
          compatibility: { date: "2024-01-01" },
        });
        const consumer = yield* Cloudflare.QueueConsumer("Consumer", {
          queueId: queue.queueId,
          scriptName: worker.workerName,
          settings: { batchSize: 5 },
        });
        return { queue, worker, consumer };
      }),
    );

    // Out-of-band delete via the SDK directly.
    yield* queues.deleteConsumer({
      accountId,
      queueId: initial.queue.queueId,
      consumerId: initial.consumer.consumerId,
    });

    const recovered = yield* stack.deploy(
      Effect.gen(function* () {
        const queue = yield* Cloudflare.Queue("Q");
        const worker = yield* Cloudflare.Worker("Worker", {
          main,
          compatibility: { date: "2024-01-01" },
        });
        const consumer = yield* Cloudflare.QueueConsumer("Consumer", {
          queueId: queue.queueId,
          scriptName: worker.workerName,
          settings: { batchSize: 11 },
        });
        return { queue, worker, consumer };
      }),
    );

    expect(recovered.consumer.consumerId).toBeTypeOf("string");
    // The new consumer must be reachable on Cloudflare — the previous
    // implementation died with "already exists but could not be found"
    // because listConsumers was single-page and ConsumerAlreadyExists
    // was caught by a generic `Effect.catch`.
    const live = yield* queues.getConsumer({
      accountId,
      queueId: recovered.queue.queueId,
      consumerId: recovered.consumer.consumerId,
    });
    expect("scriptName" in live ? live.scriptName : undefined).toEqual(
      recovered.worker.workerName,
    );

    yield* stack.destroy();
  }).pipe(logLevel),
);

/**
 * State-loss adoption. Wipe the local state for the QueueConsumer,
 * leaving the Cloudflare consumer in place. On redeploy the engine
 * calls `provider.read`, which now falls back to listConsumers when
 * `output.consumerId` is missing — so the consumer is adopted instead
 * of producing a duplicate-create attempt.
 */
test.provider("adopts existing consumer after local state loss", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* CloudflareEnvironment;

    yield* stack.destroy();

    const initial = yield* stack.deploy(
      Effect.gen(function* () {
        const queue = yield* Cloudflare.Queue("Q");
        const worker = yield* Cloudflare.Worker("Worker", {
          main,
          compatibility: { date: "2024-01-01" },
        });
        const consumer = yield* Cloudflare.QueueConsumer("Consumer", {
          queueId: queue.queueId,
          scriptName: worker.workerName,
        });
        return { queue, worker, consumer };
      }),
    );

    // Wipe just the QueueConsumer entry — Queue and Worker stay so the
    // redeploy reuses the same queueId / scriptName.
    yield* Effect.gen(function* () {
      const state = yield* yield* State;
      yield* state.delete({
        stack: stack.name,
        stage: "test",
        fqn: "Consumer",
      });
    }).pipe(Effect.provide(stack.state));

    const adopted = yield* stack.deploy(
      Effect.gen(function* () {
        const queue = yield* Cloudflare.Queue("Q");
        const worker = yield* Cloudflare.Worker("Worker", {
          main,
          compatibility: { date: "2024-01-01" },
        });
        const consumer = yield* Cloudflare.QueueConsumer("Consumer", {
          queueId: queue.queueId,
          scriptName: worker.workerName,
        });
        return { queue, worker, consumer };
      }),
    );

    // Adoption: the consumerId from Cloudflare equals the one we
    // created originally — we did not duplicate-create.
    expect(adopted.consumer.consumerId).toEqual(initial.consumer.consumerId);

    const live = yield* queues.getConsumer({
      accountId,
      queueId: adopted.queue.queueId,
      consumerId: adopted.consumer.consumerId,
    });
    expect("scriptName" in live ? live.scriptName : undefined).toEqual(
      adopted.worker.workerName,
    );

    yield* stack.destroy();
  }).pipe(logLevel),
);

/**
 * Conflict: queue already has a worker consumer pointing at a
 * *different* script. This is the regression for the user-reported
 * "already exists but could not be found" error — the previous
 * implementation filtered listConsumers by `news.scriptName`, so a
 * collision with a different script left the find empty and the
 * reconciler died with a misleading message.
 *
 * The new behaviour: detect the foreign worker consumer and fail with
 * a clear, actionable error naming both the existing script and the
 * desired one.
 */
test.provider(
  "fails clearly when queue has consumer for different script",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Phase 1: deploy worker A as the queue's consumer, then wipe just
      // the QueueConsumer state so the next deploy thinks it's a
      // greenfield create.
      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          const queue = yield* Cloudflare.Queue("Q");
          const workerA = yield* Cloudflare.Worker("WorkerA", {
            main,
            compatibility: { date: "2024-01-01" },
          });
          const consumer = yield* Cloudflare.QueueConsumer("Consumer", {
            queueId: queue.queueId,
            scriptName: workerA.workerName,
          });
          return { queue, workerA, consumer };
        }),
      );

      yield* Effect.gen(function* () {
        const state = yield* yield* State;
        yield* state.delete({
          stack: stack.name,
          stage: "test",
          fqn: "Consumer",
        });
      }).pipe(Effect.provide(stack.state));

      // Phase 2: redeploy with a different scriptName under the same
      // logical id. Cloudflare's queue still has worker A as consumer.
      const exit = yield* Effect.exit(
        stack.deploy(
          Effect.gen(function* () {
            const queue = yield* Cloudflare.Queue("Q");
            const workerB = yield* Cloudflare.Worker("WorkerB", {
              main,
              compatibility: { date: "2024-01-01" },
            });
            const consumer = yield* Cloudflare.QueueConsumer("Consumer", {
              queueId: queue.queueId,
              scriptName: workerB.workerName,
            });
            return { queue, workerB, consumer };
          }),
        ),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      const message = JSON.stringify(exit);
      // The error must name both the colliding existing script and the
      // requested one — that is the difference between "user can fix
      // this" and "what does this mean".
      expect(message).toContain(initial.workerA.workerName);
      expect(message).toContain("only one worker consumer");

      // Cleanup: re-introduce the Consumer entry pointing at workerA so
      // destroy can remove the cloud consumer.
      yield* stack.deploy(
        Effect.gen(function* () {
          const queue = yield* Cloudflare.Queue("Q");
          const workerA = yield* Cloudflare.Worker("WorkerA", {
            main,
            compatibility: { date: "2024-01-01" },
          });
          yield* Cloudflare.QueueConsumer("Consumer", {
            queueId: queue.queueId,
            scriptName: workerA.workerName,
          });
          return queue;
        }),
      );

      yield* stack.destroy();
    }).pipe(logLevel),
);
