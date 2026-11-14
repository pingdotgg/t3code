// @effect-diagnostics nodeBuiltinImport:off -- fixtures and tests use Node builtins
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no createHmac.
import * as NodeCrypto from "node:crypto";

import * as NodePlatformCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  type ManagedPolicyDocument,
  ScheduledTaskUpsertInput,
  ScheduledTaskWebhookDeliveryId,
  SecretRequestError,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as EffectScheduler from "effect/Scheduler";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";
import { renderWebhookPrompt } from "./webhookTemplate.ts";






















































import { waitForSpan, drainPendingDispatch, type LaunchInput, webhookTaskInput, pullRequestBody, requestFor, withService, queuedDeliveryCases, pullRequestFilterInput, githubEvent, githubSignature } from "./ScheduledTaskService.webhook-fixtures.testkit.ts";
it.effect("a retried save with an already used secretRef keeps the stored secret", () =>
  withService(({ service, launches, secretsByRef }) =>
    Effect.gen(function* () {
      secretsByRef.set("secret-ref:00000000000000000000000000000002", "github-secret");
      const save = webhookTaskInput({
        id: undefined,
        commandId: "command:mcp:schedule-task:release-hook",
        schedule: {
          type: "webhook",
          signature: {
            header: "x-hub-signature-256",
            encoding: "hex",
            prefix: "sha256=",
            secretRef: "secret-ref:00000000000000000000000000000002",
          },
        },
      });
      const first = yield* service.upsert(yield* save);
      const retried = yield* service.upsert(
        yield* webhookTaskInput({
          id: undefined,
          commandId: "command:mcp:schedule-task:release-hook",
          schedule: {
            type: "webhook",
            signature: {
              header: "x-hub-signature-256",
              encoding: "hex",
              prefix: "sha256=",
              secretRef: "secret-ref:00000000000000000000000000000002",
              secret: "made-up-secret",
            },
          },
        }),
      );
      assert.equal(retried.task.id, first.task.id);
      const signed = yield* service.triggerWebhook(
        requestFor(retried.task, {
          headers: {
            "content-type": "application/json",
            "x-hub-signature-256": githubSignature("github-secret"),
          },
        }),
      );
      assert.equal(signed._tag, "accepted");
      yield* Queue.take(launches);
    }),
  ),
);
it.effect("a signature without any secret is refused", () =>
  withService(({ service }) =>
    Effect.gen(function* () {
      const failure = yield* service
        .upsert(
          yield* webhookTaskInput({
            schedule: {
              type: "webhook",
              signature: { header: "x-hub-signature-256", encoding: "hex", prefix: "sha256=" },
            },
          }),
        )
        .pipe(Effect.flip);
      assert.include(failure.message, "needs a signing secret");
    }),
  ),
);
it.effect("dedupes replay keys per task, persists them, and expires them after seven days", () =>
  withService(
    ({ service, launches, sql }) =>
      Effect.gen(function* () {
        const schedule = { type: "webhook", dedupe: { replayKey: "{{headers.delivery-id}}" } };
        const { task } = yield* service.upsert(yield* webhookTaskInput({ schedule }));
        const request = requestFor(task, { headers: { "delivery-id": "A" } });
        const first = yield* service.triggerWebhook(request);
        assert.equal(first._tag === "accepted" && first.outcome, "accepted");
        yield* Queue.take(launches);
        const replay = yield* service.triggerWebhook(request);
        assert.equal(replay._tag === "accepted" && replay.outcome, "duplicate");
        assert.equal(yield* Queue.size(launches), 0);
        const other = yield* service.upsert(
          yield* webhookTaskInput({ id: "scheduled-task:other", schedule }),
        );
        yield* service.triggerWebhook(requestFor(other.task, { headers: request.headers }));
        yield* Queue.take(launches);
        yield* withService(
          ({ service: restarted }) =>
            Effect.gen(function* () {
              const replay = yield* restarted.triggerWebhook(request);
              assert.equal(replay._tag === "accepted" && replay.outcome, "duplicate");
            }),
          { sql, workers: new Map() },
        );
        yield* TestClock.adjust("7 days");
        const expired = yield* service.triggerWebhook(request);
        assert.equal(expired._tag === "accepted" && expired.outcome, "accepted");
        yield* Queue.take(launches);
        assert.include(
          (yield* service.listWebhookDeliveries({
            id: task.id,
            acceptAnyOutcome: true,
          })).deliveries.map((d) => d.outcome),
          "duplicate",
        );
      }),
    { workers: new Map() },
  ),
);
it.effect.each([1, 3])(
  "coalesces %i deliveries into one run with the latest body, headers and query",
  (count) => {
    const workers = new Map<string, Effect.Effect<void>>();
    return withService(
      ({ service, launches }) =>
        Effect.gen(function* () {
          const { task } = yield* service.upsert(
            yield* webhookTaskInput({
              prompt: "{{body.value}} {{headers.version}} {{query.version}}",
              schedule: {
                type: "webhook",
                dedupe: { coalesceKey: "{{body.key}}", coalesceWindowSeconds: 10 },
              },
            }),
          );
          for (let value = 1; value <= count; value++) {
            const bodyText = JSON.stringify({ key: "B", value });
            yield* service.triggerWebhook(
              requestFor(task, {
                bodyText,
                body: new TextEncoder().encode(bodyText),
                headers: { version: String(value) },
                query: `version=${value}`,
              }),
            );
            if (value < count) yield* TestClock.adjust("2 seconds");
          }
          const owner = (yield* service.listWebhookDeliveries({
            id: task.id,
            acceptAnyOutcome: true,
          })).deliveries.find((delivery) => delivery.outcome === "accepted")!;
          assert.isTrue(owner.pendingWindow);
          const beforeDispatch = (yield* service.getWebhookDelivery({
            id: task.id,
            deliveryId: owner.id,
            acceptAnyOutcome: true,
          })).delivery;
          assert.isTrue(beforeDispatch.pendingWindow);
          assert.equal(beforeDispatch.body, JSON.stringify({ key: "B", value: count }));
          assert.equal(beforeDispatch.headers.version, String(count));
          assert.equal(beforeDispatch.query, `version=${count}`);
          assert.equal(
            beforeDispatch.bodyBytes,
            new TextEncoder().encode(beforeDispatch.body).byteLength,
          );
          assert.equal(yield* Queue.size(launches), 0);
          yield* workers.get("webhook-coalescing")!;
          assert.equal(yield* Queue.size(launches), 0);
          yield* TestClock.adjust(count === 1 ? "10 seconds" : "6 seconds");
          yield* workers.get("webhook-coalescing")!;
          const launched = yield* Queue.take(launches);
          assert.equal(
            (launched.initialMessage!.text.match(new RegExp(`>${count}<`, "g")) ?? []).length,
            3,
          );
          yield* workers.get("webhook-coalescing")!;
          assert.equal(yield* Queue.size(launches), 0);
          const outcomes = (yield* service.listWebhookDeliveries({
            id: task.id,
            acceptAnyOutcome: true,
          })).deliveries.map((d) => d.outcome);
          const afterDispatch = (yield* service.getWebhookDelivery({
            id: task.id,
            deliveryId: owner.id,
            acceptAnyOutcome: true,
          })).delivery;
          assert.isFalse(afterDispatch.pendingWindow);
          assert.equal(afterDispatch.body, beforeDispatch.body);
          assert.include(afterDispatch.renderedPrompt!, `>${count}<`);
          assert.equal(outcomes.filter((o) => o === "accepted").length, 1);
          assert.equal(outcomes.filter((o) => o === "coalesced").length, count - 1);
        }),
      { workers },
    );
  },
);
it.effect("a coalesced window dispatches the prompt saved after it opened", () => {
  const workers = new Map<string, Effect.Effect<void>>();
  return withService(
    ({ service, launches }) =>
      Effect.gen(function* () {
        const schedule = {
          type: "webhook",
          dedupe: { coalesceKey: "{{body.id}}", coalesceWindowSeconds: 10 },
        };
        const { task } = yield* service.upsert(
          yield* webhookTaskInput({ prompt: "Use the original instructions.", schedule }),
        );
        const bodyText = JSON.stringify({ id: "review" });
        yield* service.triggerWebhook(
          requestFor(task, { bodyText, body: new TextEncoder().encode(bodyText) }),
        );
        yield* service.upsert(
          yield* webhookTaskInput({ prompt: "Use the updated instructions.", schedule }),
        );
        yield* TestClock.adjust("10 seconds");
        yield* workers.get("webhook-coalescing")!;
        const launched = yield* Queue.take(launches);
        assert.equal(launched.initialMessage?.text, "Use the updated instructions.");
        const owner = (yield* service.listWebhookDeliveries({ id: task.id })).deliveries[0]!;
        const { delivery } = yield* service.getWebhookDelivery({
          id: task.id,
          deliveryId: owner.id,
        });
        assert.equal(delivery.renderedPrompt, "Use the updated instructions.");
      }),
    { workers },
  );
});
it.effect("retrying a running window keeps the prompt it was dispatched with", () => {
  const workers = new Map<string, Effect.Effect<void>>();
  return withService(
    ({ service, sql, launches }) =>
      Effect.gen(function* () {
        const schedule = {
          type: "webhook",
          dedupe: { coalesceKey: "{{body}}", coalesceWindowSeconds: 10 },
        };
        const save = (prompt: string) =>
          Effect.flatMap(webhookTaskInput({ prompt, schedule }), service.upsert);
        const { task } = yield* save("Prompt when the window opened");
        yield* service.triggerWebhook(requestFor(task));
        yield* save("Prompt at dispatch");
        yield* sql`CREATE TRIGGER fail_completion BEFORE UPDATE ON scheduled_tasks
          WHEN NEW.last_run_status = 'succeeded' BEGIN SELECT RAISE(FAIL, 'completion unavailable'); END`;
        yield* TestClock.adjust("10 seconds");
        yield* drainPendingDispatch(workers);
        const launched = yield* Queue.take(launches);
        assert.equal(launched.initialMessage?.text, "Prompt at dispatch");
        yield* save("Prompt saved after dispatch");
        yield* sql`DROP TRIGGER fail_completion`;
        yield* drainPendingDispatch(workers);
        assert.equal((yield* sql`SELECT 1 FROM scheduled_task_webhook_pending`).length, 0);
        const owner = (yield* service.listWebhookDeliveries({ id: task.id })).deliveries[0]!;
        const { delivery } = yield* service.getWebhookDelivery({
          id: task.id,
          deliveryId: owner.id,
        });
        assert.equal(delivery.renderedPrompt, "Prompt at dispatch");
      }),
    { workers },
  );
});
it.effect("a coalesced window fails its delivery when the task row cannot be read", () => {
  const workers = new Map<string, Effect.Effect<void>>();
  return withService(
    ({ service, sql, launches }) =>
      Effect.gen(function* () {
        const { task } = yield* service.upsert(
          yield* webhookTaskInput({
            schedule: {
              type: "webhook",
              dedupe: { coalesceKey: "{{body}}", coalesceWindowSeconds: 10 },
            },
          }),
        );
        yield* service.triggerWebhook(requestFor(task));
        yield* sql`UPDATE scheduled_tasks SET model_selection_json = 'not json' WHERE task_id = ${task.id}`;
        yield* TestClock.adjust("10 seconds");
        yield* drainPendingDispatch(workers);
        assert.equal(yield* Queue.size(launches), 0);
        assert.equal((yield* sql`SELECT 1 FROM scheduled_task_webhook_pending`).length, 0);
        const [delivery] = yield* sql<{
          outcome: string;
          error: string | null;
        }>`SELECT outcome, error FROM scheduled_task_webhook_deliveries`;
        assert.equal(delivery?.outcome, "dispatch_failed");
        // Failing before dispatch means a later successful read cannot send the stale snapshot.
        assert.equal(delivery?.error, "The pending webhook payload could not be prepared.");
      }),
    { workers },
  );
});
it.effect("recovers a persisted coalescing window after restarting the service", () => {
  const workers = new Map<string, Effect.Effect<void>>();
  return withService(
    ({ service, sql }) =>
      Effect.gen(function* () {
        const { task } = yield* service.upsert(
          yield* webhookTaskInput({
            schedule: {
              type: "webhook",
              dedupe: { coalesceKey: "{{headers.content-type}}", coalesceWindowSeconds: 10 },
            },
          }),
        );
        yield* service.triggerWebhook(requestFor(task));
        yield* TestClock.adjust("4 seconds");
        const restartedWorkers = new Map<string, Effect.Effect<void>>();
        yield* withService(
          ({ launches }) =>
            Effect.gen(function* () {
              yield* restartedWorkers.get("webhook-coalescing")!;
              assert.equal(yield* Queue.size(launches), 0);
              yield* TestClock.adjust("6 seconds");
              yield* restartedWorkers.get("webhook-coalescing")!;
              yield* Queue.take(launches);
              yield* restartedWorkers.get("webhook-coalescing")!;
              assert.equal(yield* Queue.size(launches), 0);
              assert.equal((yield* sql`SELECT * FROM scheduled_task_webhook_pending`).length, 0);
            }),
          { sql, workers: restartedWorkers },
        );
      }),
    { workers },
  );
});
it.effect("a pending dispatch interrupted at its permit does not block later polls", () => {
  const workers = new Map<string, Effect.Effect<void>>();
  // One shared dispatcher lets the test run the retry's forked worker to completion.
  const mixed = new EffectScheduler.MixedScheduler("sync");
  const dispatcher = mixed.makeDispatcher();
  return withService(
    ({ service, sql, launches }) =>
      Effect.gen(function* () {
        const { task } = yield* service.upsert(
          yield* webhookTaskInput({
            schedule: {
              type: "webhook",
              dedupe: { coalesceKey: "{{headers.content-type}}", coalesceWindowSeconds: 10 },
            },
          }),
        );
        yield* service.triggerWebhook(requestFor(task));
        yield* TestClock.adjust("10 seconds");
        const poll = workers.get("webhook-coalescing")!;

        const entered = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>();
        const interruptAtPermit = Tracer.make({
          span: (options) => {
            if (options.name === "ScheduledTaskService.webhookPermit") {
              const fiber = Fiber.getCurrent()!;
              Deferred.doneUnsafe(entered, Effect.succeed(fiber));
              fiber.interruptUnsafe();
            }
            return new Tracer.NativeSpan(options);
          },
        });
        const firstPoll = yield* poll.pipe(Effect.withTracer(interruptAtPermit), Effect.forkChild);
        assert.isTrue(Exit.hasInterrupts(yield* Fiber.await(yield* Deferred.await(entered))));
        yield* Fiber.await(firstPoll);

        yield* poll;
        dispatcher.flush();

        assert.equal(yield* Queue.size(launches), 1);
        assert.lengthOf(yield* sql`SELECT 1 FROM scheduled_task_webhook_pending`, 0);
      }),
    { workers },
  ).pipe(
    Effect.provideService(EffectScheduler.Scheduler, {
      executionMode: mixed.executionMode,
      makeDispatcher: () => dispatcher,
      shouldYield: (fiber) => mixed.shouldYield(fiber),
    }),
  );
});
it.effect("rolls back replay and pending state when recording a delivery fails", () => {
  const workers = new Map<string, Effect.Effect<void>>();
  return withService(
    ({ service, sql, launches }) =>
      Effect.gen(function* () {
        const { task } = yield* service.upsert(
          yield* webhookTaskInput({
            schedule: {
              type: "webhook",
              dedupe: {
                replayKey: "{{headers.content-type}}",
                coalesceKey: "{{headers.content-type}}",
                coalesceWindowSeconds: 10,
              },
            },
          }),
        );
        yield* sql`CREATE TRIGGER fail_dedupe_log BEFORE INSERT ON scheduled_task_webhook_deliveries BEGIN SELECT RAISE(FAIL, 'injected'); END`;
        yield* service.triggerWebhook(requestFor(task)).pipe(Effect.flip);
        assert.equal((yield* sql`SELECT * FROM scheduled_task_webhook_pending`).length, 0);
        assert.equal((yield* sql`SELECT * FROM scheduled_task_webhook_replay_keys`).length, 0);
        yield* sql`DROP TRIGGER fail_dedupe_log`;
        const retry = yield* service.triggerWebhook(requestFor(task));
        assert.equal(retry._tag === "accepted" && retry.outcome, "accepted");
        yield* TestClock.adjust("10 seconds");
        yield* workers.get("webhook-coalescing")!;
        yield* Queue.take(launches);
      }),
    { workers },
  );
});
it.effect("queue-full deliveries release replay keys so a later retry runs", () =>
  Effect.gen(function* () {
    const gate = yield* Deferred.make<void>();
    yield* withService(
      ({ service, launches }) =>
        Effect.gen(function* () {
          const { task } = yield* service.upsert(
            yield* webhookTaskInput({
              schedule: { type: "webhook", dedupe: { replayKey: "{{headers.delivery-id}}" } },
            }),
          );
          const request = (i: number) =>
            requestFor(task, { headers: { "delivery-id": String(i) } });
          for (let i = 0; i < 20; i++) yield* service.triggerWebhook(request(i));
          yield* Queue.take(launches);
          const full = yield* service.triggerWebhook(request(20));
          assert.equal(full._tag === "rate_limited" && full.outcome, "queue_full");
          yield* Deferred.succeed(gate, undefined);
          for (let i = 1; i < 20; i++) yield* Queue.take(launches);
          const retry = yield* service.triggerWebhook(request(20));
          assert.equal(retry._tag === "accepted" && retry.outcome, "accepted");
          yield* Queue.take(launches);
        }),
      { gate },
    );
  }),
);
it.effect.each(["task_json", "request_json"] as const)(
  "removes corrupt pending %s instead of retrying forever",
  (column) => {
    const workers = new Map<string, Effect.Effect<void>>();
    return withService(
      ({ service, sql }) =>
        Effect.gen(function* () {
          const { task } = yield* service.upsert(
            yield* webhookTaskInput({
              schedule: {
                type: "webhook",
                dedupe: {
                  replayKey: "{{body}}",
                  coalesceKey: "{{body}}",
                  coalesceWindowSeconds: 10,
                },
              },
            }),
          );
          yield* service.triggerWebhook(requestFor(task));
          yield* sql`UPDATE scheduled_task_webhook_pending SET ${sql(column)} = 'broken'`;
          yield* TestClock.adjust("10 seconds");
          yield* drainPendingDispatch(workers);
          assert.equal((yield* sql`SELECT * FROM scheduled_task_webhook_pending`).length, 0);
          assert.equal((yield* sql`SELECT * FROM scheduled_task_webhook_replay_keys`).length, 0);
          assert.equal(
            (yield* service.listWebhookDeliveries({ id: task.id })).deliveries[0]!.outcome,
            "dispatch_failed",
          );
          yield* workers.get("webhook-coalescing")!;
        }),
      { workers },
    );
  },
);
it.effect(
  "restarting after a coalesced launch before pending deletion does not launch or count it twice",
  () => {
    const workers = new Map<string, Effect.Effect<void>>();
    return withService(
      ({ service, sql, launches }) =>
        Effect.gen(function* () {
          const { task } = yield* service.upsert(
            yield* webhookTaskInput({
              schedule: {
                type: "webhook",
                dedupe: { coalesceKey: "{{body}}", coalesceWindowSeconds: 10 },
              },
            }),
          );
          const accepted = yield* service.triggerWebhook(requestFor(task));
          yield* sql`CREATE TRIGGER fail_pending_delete BEFORE DELETE ON scheduled_task_webhook_pending BEGIN SELECT RAISE(FAIL,'crash after launch'); END`;
          yield* TestClock.adjust("10 seconds");
          yield* drainPendingDispatch(workers);
          const launch = yield* Queue.take(launches);
          assert.equal(
            launch.commandId,
            `scheduled-task:${task.id}:webhook:${accepted._tag === "accepted" && accepted.deliveryId}`,
          );
          assert.equal((yield* service.list()).tasks[0]!.runCount, 1);
          assert.equal(
            (yield* sql`SELECT * FROM scheduled_task_webhook_pending WHERE state = 'completed'`)
              .length,
            1,
          );
          yield* sql`DROP TRIGGER fail_pending_delete`;
          const restartedWorkers = new Map<string, Effect.Effect<void>>();
          yield* withService(
            ({ service: restarted, launches: secondLaunches }) =>
              Effect.gen(function* () {
                yield* drainPendingDispatch(restartedWorkers);
                assert.equal(yield* Queue.size(secondLaunches), 0);
                assert.equal((yield* restarted.list()).tasks[0]!.runCount, 1);
                assert.equal((yield* sql`SELECT * FROM scheduled_task_webhook_pending`).length, 0);
              }),
            { sql, workers: restartedWorkers },
          );
        }),
      { workers },
    );
  },
);
it.effect("guards bad-signature floods separately from valid run admission", () =>
  withService(({ service, sql }) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(
        yield* webhookTaskInput({
          schedule: {
            type: "webhook",
            signature: { header: "signature", encoding: "hex", prefix: "", secret: "secret" },
          },
        }),
      );
      const results = yield* Effect.forEach(Array.from({ length: 75 }), () =>
        service.triggerWebhook(requestFor(task)),
      );
      assert.equal(results.filter((result) => result._tag === "rejected_signature").length, 60);
      assert.equal(results.filter((result) => result._tag === "rate_limited").length, 15);
      assert.equal((yield* sql`SELECT * FROM scheduled_task_webhook_deliveries`).length, 51);
    }),
  ),
);
it.effect("start failures release both replay keys and relay claims for redelivery", () =>
  withService(
    ({ service, sql, launches }) =>
      Effect.gen(function* () {
        const { task } = yield* service.upsert(
          yield* webhookTaskInput({
            schedule: { type: "webhook", dedupe: { replayKey: "{{body}}" } },
          }),
        );
        const request = requestFor(task, { relayDeliveryId: "failed-start" });
        yield* waitForSpan(
          service.triggerWebhook(request),
          "ScheduledTaskService.runWebhookDelivery",
        );
        yield* Queue.take(launches);
        assert.equal((yield* sql`SELECT * FROM scheduled_task_webhook_replay_keys`).length, 0);
        assert.equal((yield* sql`SELECT * FROM scheduled_task_webhook_relay_deliveries`).length, 0);
        assert.equal((yield* service.list()).tasks[0]!.lastRunError, "injected start failure");
        const retry = yield* waitForSpan(
          service.triggerWebhook(request),
          "ScheduledTaskService.runWebhookDelivery",
        );
        assert.equal(retry._tag === "accepted" && retry.outcome, "accepted");
        yield* Queue.take(launches);
        assert.equal((yield* service.list()).tasks[0]!.lastRunStatus, "succeeded");
      }),
    { failLaunches: { remaining: 1 } },
  ),
);
it.effect("a start failure releases the relay claim when the task row is replaced mid-run", () =>
  Effect.gen(function* () {
    const gate = yield* Deferred.make<void>();
    yield* withService(
      ({ service, sql, launches }) =>
        Effect.gen(function* () {
          const { task } = yield* service.upsert(yield* webhookTaskInput());
          const request = requestFor(task, { relayDeliveryId: "replaced-mid-run" });
          const first = yield* waitForSpan(
            service.triggerWebhook(request),
            "ScheduledTaskService.runWebhookDelivery",
          ).pipe(Effect.forkChild);
          yield* Queue.take(launches);
          // A same-id recreate while the launch is out: the stored row is no longer this run's.
          yield* sql`UPDATE scheduled_tasks SET last_run_status = 'never', last_run_at = NULL`;
          yield* Deferred.succeed(gate, undefined);
          yield* Fiber.join(first);
          const retry = yield* service.triggerWebhook(request);
          assert.equal(retry._tag === "accepted" && retry.outcome, "accepted");
          yield* Queue.take(launches);
        }),
      { gate, failLaunches: { remaining: 1 } },
    );
  }),
);
it.effect("main retention keeps fifty runs and preserves filtered and dedupe buckets", () =>
  withService(({ service, sql, launches }) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(yield* webhookTaskInput());
      yield* service.triggerWebhook(requestFor(task));
      yield* Queue.take(launches);
      for (const outcome of ["filtered", "duplicate"]) {
        yield* sql`WITH RECURSIVE n(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM n WHERE value < 20)
        INSERT INTO scheduled_task_webhook_deliveries
        SELECT ${outcome} || n.value, d.task_id, d.received_at, d.method, d.query, d.headers_json, d.body,
          d.body_bytes, d.body_truncated, ${outcome}, d.signature_verified, d.missing_fields_json, d.rendered_prompt, d.error
        FROM n CROSS JOIN (SELECT * FROM scheduled_task_webhook_deliveries WHERE outcome = 'accepted' LIMIT 1) d`;
      }
      for (let i = 0; i < 59; i++) {
        assert.equal((yield* service.triggerWebhook(requestFor(task)))._tag, "accepted");
        yield* Queue.take(launches);
      }
      const counts = yield* sql<{
        outcome: string;
        count: number;
      }>`SELECT outcome, COUNT(*) AS count FROM scheduled_task_webhook_deliveries GROUP BY outcome ORDER BY outcome`;
      assert.deepEqual(counts, [
        { outcome: "accepted", count: 50 },
        { outcome: "duplicate", count: 20 },
        { outcome: "filtered", count: 20 },
      ]);
    }),
  ),
);
