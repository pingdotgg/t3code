import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { generateLocalId, isLiveId } from "@/Cloudflare/LocalRuntime";
import * as Provider from "@/Provider";
import { State } from "@/State";
import type { CreatedResourceState } from "@/State/ResourceState";
import * as Test from "@/Test/Alchemy";
import * as queues from "@distilled.cloud/cloudflare/queues";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
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
    const env = yield* CloudflareEnvironment;
    const { accountId } = yield* env;

    yield* stack.destroy();

    const initial = yield* stack.deploy(
      Effect.gen(function* () {
        const queue = yield* Cloudflare.Queues.Queue("Q");
        const workerA = yield* Cloudflare.Worker("WorkerA", {
          main,
          compatibility: { date: "2024-01-01" },
        });
        const consumer = yield* Cloudflare.Queues.Consumer("Consumer", {
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
        const queue = yield* Cloudflare.Queues.Queue("Q");
        const workerA = yield* Cloudflare.Worker("WorkerA", {
          main,
          compatibility: { date: "2024-01-01" },
        });
        const consumer = yield* Cloudflare.Queues.Consumer("Consumer", {
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
        const queue = yield* Cloudflare.Queues.Queue("Q");
        yield* Cloudflare.Worker("WorkerA", {
          main,
          compatibility: { date: "2024-01-01" },
        });
        const workerB = yield* Cloudflare.Worker("WorkerB", {
          main,
          compatibility: { date: "2024-01-01" },
        });
        const consumer = yield* Cloudflare.Queues.Consumer("Consumer", {
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
    const env = yield* CloudflareEnvironment;
    const { accountId } = yield* env;

    yield* stack.destroy();

    const initial = yield* stack.deploy(
      Effect.gen(function* () {
        const queue = yield* Cloudflare.Queues.Queue("Q");
        const worker = yield* Cloudflare.Worker("Worker", {
          main,
          compatibility: { date: "2024-01-01" },
        });
        const consumer = yield* Cloudflare.Queues.Consumer("Consumer", {
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
        const queue = yield* Cloudflare.Queues.Queue("Q");
        const worker = yield* Cloudflare.Worker("Worker", {
          main,
          compatibility: { date: "2024-01-01" },
        });
        const consumer = yield* Cloudflare.Queues.Consumer("Consumer", {
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
    // was caught by a generic `Effect.catch`. A freshly-created consumer
    // can briefly 404 from this out-of-band read under load, so ride out
    // the read-after-create lag before asserting.
    const live = yield* queues
      .getConsumer({
        accountId,
        queueId: recovered.queue.queueId,
        consumerId: recovered.consumer.consumerId,
      })
      .pipe(
        Effect.retry({
          while: (e) => e._tag === "ConsumerNotFound",
          schedule: Schedule.exponential("500 millis"),
          times: 8,
        }),
      );
    expect("scriptName" in live ? live.scriptName : undefined).toEqual(
      recovered.worker.workerName,
    );

    yield* stack.destroy();
  }).pipe(logLevel),
);

/**
 * State-loss adoption. Wipe the local state for the Consumer,
 * leaving the Cloudflare consumer in place. On redeploy the engine
 * calls `provider.read`, which now falls back to listConsumers when
 * `output.consumerId` is missing — so the consumer is adopted instead
 * of producing a duplicate-create attempt.
 */
test.provider("adopts existing consumer after local state loss", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const initial = yield* stack.deploy(
      Effect.gen(function* () {
        const queue = yield* Cloudflare.Queues.Queue("Q");
        const worker = yield* Cloudflare.Worker("Worker", {
          main,
          compatibility: { date: "2024-01-01" },
        });
        const consumer = yield* Cloudflare.Queues.Consumer("Consumer", {
          queueId: queue.queueId,
          scriptName: worker.workerName,
        });
        return { queue, worker, consumer };
      }),
    );

    // Wipe just the Consumer entry — Queue and Worker stay so the
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
        const queue = yield* Cloudflare.Queues.Queue("Q");
        const worker = yield* Cloudflare.Worker("Worker", {
          main,
          compatibility: { date: "2024-01-01" },
        });
        const consumer = yield* Cloudflare.Queues.Consumer("Consumer", {
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
      // the Consumer state so the next deploy thinks it's a
      // greenfield create.
      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          const queue = yield* Cloudflare.Queues.Queue("Q");
          const workerA = yield* Cloudflare.Worker("WorkerA", {
            main,
            compatibility: { date: "2024-01-01" },
          });
          const consumer = yield* Cloudflare.Queues.Consumer("Consumer", {
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
            const queue = yield* Cloudflare.Queues.Queue("Q");
            const workerB = yield* Cloudflare.Worker("WorkerB", {
              main,
              compatibility: { date: "2024-01-01" },
            });
            const consumer = yield* Cloudflare.Queues.Consumer("Consumer", {
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
          const queue = yield* Cloudflare.Queues.Queue("Q");
          const workerA = yield* Cloudflare.Worker("WorkerA", {
            main,
            compatibility: { date: "2024-01-01" },
          });
          yield* Cloudflare.Queues.Consumer("Consumer", {
            queueId: queue.queueId,
            scriptName: workerA.workerName,
          });
          return queue;
        }),
      );

      yield* stack.destroy();
    }).pipe(logLevel),
);

/**
 * Suppressed delete: a consumer that only ever existed in dev (its
 * persisted `consumerId` is a `dev:` mock id) has no Cloudflare
 * counterpart. Destroying it must NOT issue a `deleteConsumer` against
 * Cloudflare — the `dev:` ids are not valid and the request URL would be
 * malformed. The live provider's `delete` short-circuits on the non-live
 * id, so destroy succeeds and the state row is removed cleanly.
 */
test.provider("suppresses deletion of a dev-only consumer", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const devQueueId = generateLocalId();
    const devConsumerId = generateLocalId();

    yield* Effect.gen(function* () {
      const state = yield* yield* State;
      yield* state.set({
        stack: stack.name,
        stage: "test",
        fqn: "Consumer",
        value: {
          kind: "resource",
          status: "created",
          resourceType: "Cloudflare.Queues.Consumer",
          namespace: undefined,
          fqn: "Consumer",
          logicalId: "Consumer",
          instanceId: "00000000000000000000000000000002",
          providerVersion: 0,
          bindings: [],
          downstream: [],
          props: {
            queueId: devQueueId,
            scriptName: "dev-worker",
          },
          attr: {
            consumerId: devConsumerId,
            queueId: devQueueId,
            scriptName: "dev-worker",
            accountId,
          },
        } satisfies CreatedResourceState,
      });
    });

    // Destroy must not attempt a (malformed) live delete against the dev ids.
    const exit = yield* Effect.exit(stack.destroy());
    expect(Exit.isSuccess(exit)).toBe(true);

    // The dev-only resource is removed from state.
    const persisted = yield* Effect.gen(function* () {
      const state = yield* yield* State;
      return yield* state.get({
        stack: stack.name,
        stage: "test",
        fqn: "Consumer",
      });
    });
    expect(persisted).toBeUndefined();
  }).pipe(logLevel),
);

/**
 * Promotion: a consumer whose persisted `consumerId` is a `dev:` mock id
 * must be promoted to a real Cloudflare consumer on a live deploy.
 *
 * We first deploy a real queue + worker + consumer, then rewrite the
 * persisted consumer's `consumerId` back to a `dev:` id (leaving the
 * `queueId` live — in a real dev→live transition the upstream Queue is
 * promoted first, so the consumer's queue ref is already a live id while
 * its own id is still the dev one it was minted with). On redeploy the
 * live provider's `diff` sees the `dev:` consumerId and returns `update`
 * (not `noop`), so `reconcile` runs, re-observes the live consumer, and
 * the persisted id is healed back to the real one.
 */
test.provider("promotes a dev consumer to a live consumer on deploy", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const buildStack = Effect.gen(function* () {
      const queue = yield* Cloudflare.Queues.Queue("Q");
      const worker = yield* Cloudflare.Worker("Worker", {
        main,
        compatibility: { date: "2024-01-01" },
      });
      const consumer = yield* Cloudflare.Queues.Consumer("Consumer", {
        queueId: queue.queueId,
        scriptName: worker.workerName,
        settings: { batchSize: 5 },
      });
      return { queue, worker, consumer };
    });

    const initial = yield* stack.deploy(buildStack);
    expect(isLiveId(initial.consumer.consumerId)).toBe(true);

    // Rewrite the persisted consumerId back to a dev id, simulating a
    // consumer that was minted in `alchemy dev`.
    const devQueueId = generateLocalId();
    const devConsumerId = generateLocalId();
    yield* Effect.gen(function* () {
      const state = yield* yield* State;
      const currentConsumer = (yield* state.get({
        stack: stack.name,
        stage: "test",
        fqn: "Consumer",
      })) as CreatedResourceState;
      yield* state.set({
        stack: stack.name,
        stage: "test",
        fqn: "Consumer",
        value: {
          ...currentConsumer,
          attr: {
            ...currentConsumer.attr,
            queueId: devQueueId,
            consumerId: devConsumerId,
          },
        },
      });
    });

    const promoted = yield* stack.deploy(buildStack);

    // The dev id was promoted back to the real, live consumer id.
    expect(isLiveId(promoted.consumer.consumerId)).toBe(true);
    expect(isLiveId(promoted.queue.queueId)).toBe(true);
    expect(promoted.consumer.consumerId).not.toEqual(devConsumerId);
    expect(promoted.consumer.consumerId).toEqual(initial.consumer.consumerId);
    expect(promoted.queue.queueId).toEqual(initial.queue.queueId);

    const live = yield* queues.getConsumer({
      accountId,
      queueId: promoted.queue.queueId,
      consumerId: promoted.consumer.consumerId,
    });
    expect("scriptName" in live ? live.scriptName : undefined).toEqual(
      promoted.worker.workerName,
    );

    yield* stack.destroy();
  }).pipe(logLevel),
);

/**
 * Canonical `list()` test (parent fan-out): queue consumers have no
 * account-wide enumeration API, so `list()` enumerates every queue in the
 * account and lists each queue's worker consumer. Deploy a queue + worker +
 * consumer, then assert the consumer is present in the exhaustively-
 * paginated result, hydrated into the same `Attributes` shape `read` returns.
 */
test.provider("list enumerates the deployed consumer", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const deployed = yield* stack.deploy(
      Effect.gen(function* () {
        const queue = yield* Cloudflare.Queues.Queue("Q");
        const worker = yield* Cloudflare.Worker("Worker", {
          main,
          compatibility: { date: "2024-01-01" },
        });
        const consumer = yield* Cloudflare.Queues.Consumer("Consumer", {
          queueId: queue.queueId,
          scriptName: worker.workerName,
          settings: { batchSize: 7 },
        });
        return { queue, worker, consumer };
      }),
    );

    const provider = yield* Provider.findProvider(Cloudflare.Queues.Consumer);
    const all = yield* provider.list();

    const found = all.find(
      (c) => c.consumerId === deployed.consumer.consumerId,
    );
    expect(found).toBeDefined();
    expect(found?.queueId).toEqual(deployed.queue.queueId);
    expect(found?.scriptName).toEqual(deployed.worker.workerName);
    expect(found?.accountId).toBeTypeOf("string");

    yield* stack.destroy();
  }).pipe(logLevel),
);
