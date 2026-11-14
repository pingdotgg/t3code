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






















































import { waitForSpan, drainPendingDispatch, type LaunchInput, webhookTaskInput, pullRequestBody, requestFor, withService, queuedDeliveryCases, pullRequestFilterInput, githubEvent } from "./ScheduledTaskService.webhook-fixtures.testkit.ts";
it.effect(
  "a valid request refunds its own reservation without expiring an interleaved rejection",
  () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      yield* withService(
        ({ service, launches }) =>
          Effect.gen(function* () {
            const { task } = yield* service.upsert(
              yield* webhookTaskInput({
                schedule: {
                  type: "webhook",
                  signature: { header: "signature", encoding: "hex", prefix: "", secret: "secret" },
                },
              }),
            );
            const signature = NodeCrypto.createHmac("sha256", "secret")
              .update(pullRequestBody)
              .digest("hex");
            const valid = yield* service
              .triggerWebhook(requestFor(task, { headers: { signature } }))
              .pipe(Effect.forkChild);
            yield* Deferred.await(started);
            yield* TestClock.adjust("30 seconds");
            assert.equal(
              (yield* service.triggerWebhook(requestFor(task)))._tag,
              "rejected_signature",
            );
            yield* Deferred.succeed(release, undefined);
            assert.equal((yield* Fiber.join(valid))._tag, "accepted");
            yield* Queue.take(launches);
            // Only the valid reservation would have expired now; the rejection must still count.
            yield* TestClock.adjust("31 seconds");
            for (let i = 0; i < 59; i++)
              assert.equal(
                (yield* service.triggerWebhook(requestFor(task)))._tag,
                "rejected_signature",
              );
            assert.equal((yield* service.triggerWebhook(requestFor(task)))._tag, "rate_limited");
          }),
        { frameGate: { started, release } },
      );
    }),
);
it.effect("keeps replay keys when dispatch succeeds but completion bookkeeping fails", () =>
  withService(({ service, sql, launches }) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(
        yield* webhookTaskInput({
          schedule: {
            type: "webhook",
            dedupe: { replayKey: "{{body}}" },
          },
        }),
      );
      yield* sql`CREATE TRIGGER fail_completion BEFORE UPDATE ON scheduled_tasks
      WHEN NEW.last_run_status = 'succeeded' BEGIN SELECT RAISE(FAIL, 'completion unavailable'); END`;
      yield* waitForSpan(
        service.triggerWebhook(requestFor(task)),
        "ScheduledTaskService.runWebhookDelivery",
      );
      yield* Queue.take(launches);
      assert.equal((yield* sql`SELECT 1 FROM scheduled_task_webhook_replay_keys`).length, 1);
      yield* sql`DROP TRIGGER fail_completion`;
      const retry = yield* service.triggerWebhook(requestFor(task));
      assert.equal(retry._tag === "accepted" && retry.outcome, "duplicate");
      assert.equal(yield* Queue.size(launches), 0);
      assert.equal((yield* service.list()).tasks[0]!.runCount, 1);
    }),
  ),
);
it.effect.each([119_000, 120_000])(
  "bounds coalesced prompt logs and checks trimmed length for %i body characters",
  (length) => {
    const workers = new Map<string, Effect.Effect<void>>();
    return withService(
      ({ service, launches }) =>
        Effect.gen(function* () {
          const { task } = yield* service.upsert(
            yield* webhookTaskInput({
              prompt: `{{body.absent}}${" ".repeat(10_000)}{{body.text}}`,
              schedule: {
                type: "webhook",
                dedupe: { coalesceKey: "{{body.group}}", coalesceWindowSeconds: 10 },
              },
            }),
          );
          const bodyText = JSON.stringify({ group: "B", text: "x".repeat(length) });
          const accepted = yield* service.triggerWebhook(
            requestFor(task, { bodyText, body: new TextEncoder().encode(bodyText) }),
          );
          assert.equal(accepted._tag, "accepted");
          yield* TestClock.adjust("10 seconds");
          yield* drainPendingDispatch(workers);
          const delivery = (yield* service.listWebhookDeliveries({ id: task.id })).deliveries[0]!;
          if (length === 119_000) {
            const launch = yield* Queue.take(launches);
            assert.isAbove(launch.initialMessage!.text.length, 120_000);
            assert.equal(delivery.outcome, "accepted");
            const detail = yield* service.getWebhookDelivery({
              id: task.id,
              deliveryId: delivery.id,
            });
            assert.equal(detail.delivery.renderedPrompt!.length, 64 * 1024);
          } else {
            assert.equal(yield* Queue.size(launches), 0);
            assert.equal(delivery.outcome, "dispatch_failed");
            assert.equal(delivery.error, "The filled-in prompt is too long.");
          }
        }),
      { workers },
    );
  },
);
it.effect("oversized coalesced windows stay within the suppression bucket's limit", () => {
  const workers = new Map<string, Effect.Effect<void>>();
  return withService(
    ({ service, sql, launches }) =>
      Effect.gen(function* () {
        const { task } = yield* service.upsert(
          yield* webhookTaskInput({
            prompt: `{{body.absent}}${" ".repeat(10_000)}{{body.text}}`,
            schedule: {
              type: "webhook",
              dedupe: { coalesceKey: "{{body.group}}", coalesceWindowSeconds: 10 },
            },
          }),
        );
        const bodyText = JSON.stringify({ group: "B", text: "x".repeat(120_000) });
        for (let i = 0; i < 21; i++) {
          const accepted = yield* service.triggerWebhook(
            requestFor(task, { bodyText, body: new TextEncoder().encode(bodyText) }),
          );
          assert.equal(accepted._tag === "accepted" && accepted.outcome, "accepted");
          yield* TestClock.adjust("10 seconds");
          yield* drainPendingDispatch(workers);
        }
        assert.equal(yield* Queue.size(launches), 0);
        const counts = yield* sql<{
          outcome: string;
          count: number;
        }>`SELECT outcome, COUNT(*) AS count FROM scheduled_task_webhook_deliveries GROUP BY outcome`;
        assert.deepEqual(counts, [{ outcome: "dispatch_failed", count: 20 }]);
      }),
    { workers },
  );
});
it.effect.each([1, 11])(
  "keeps relay claims for %i coalesced updates after their window closes",
  (count) => {
    const workers = new Map<string, Effect.Effect<void>>();
    return withService(
      ({ service, sql, launches }) =>
        Effect.gen(function* () {
          const { task } = yield* service.upsert(
            yield* webhookTaskInput({
              prompt: "{{body.value}}",
              schedule: {
                type: "webhook",
                dedupe: { coalesceKey: "{{body.group}}", coalesceWindowSeconds: 10 },
              },
            }),
          );
          const request = (value: number) => {
            const bodyText = JSON.stringify({ group: "B", value });
            return requestFor(task, {
              relayDeliveryId: `coalesced-relay-${value}`,
              bodyText,
              body: new TextEncoder().encode(bodyText),
            });
          };
          yield* service.triggerWebhook(request(0));
          for (let i = 1; i <= count; i++) {
            const result = yield* service.triggerWebhook(request(i));
            assert.equal(result._tag === "accepted" && result.outcome, "coalesced");
          }
          assert.equal(
            (yield* sql`SELECT 1 FROM scheduled_task_webhook_relay_deliveries`).length,
            count + 1,
          );
          yield* TestClock.adjust("10 seconds");
          yield* drainPendingDispatch(workers);
          assert.include((yield* Queue.take(launches)).initialMessage!.text, `>${count}<`);
          const retry = yield* service.triggerWebhook(request(count));
          assert.equal(retry._tag === "accepted" && retry.outcome, "duplicate");
          assert.equal((yield* sql`SELECT 1 FROM scheduled_task_webhook_pending`).length, 0);
          assert.equal((yield* service.list()).tasks[0]!.runCount, 1);
          assert.equal(yield* Queue.size(launches), 0);
        }),
      { workers },
    );
  },
);
it.effect("failed windows release every member's replay key and relay claim", () => {
  const workers = new Map<string, Effect.Effect<void>>();
  return withService(
    ({ service, sql, launches }) =>
      Effect.gen(function* () {
        const { task } = yield* service.upsert(
          yield* webhookTaskInput({
            prompt: "{{body.value}}",
            schedule: {
              type: "webhook",
              dedupe: {
                replayKey: "{{headers.delivery-id}}",
                coalesceKey: "{{body.group}}",
                coalesceWindowSeconds: 10,
              },
            },
          }),
        );
        const request = (id: string) => {
          const bodyText = JSON.stringify({ group: "same", value: id });
          return requestFor(task, {
            bodyText,
            body: new TextEncoder().encode(bodyText),
            headers: { "delivery-id": id },
            relayDeliveryId: id,
          });
        };
        yield* service.triggerWebhook(request("A"));
        for (let i = 0; i < 12; i++) yield* service.triggerWebhook(request(`B${i}`));
        assert.equal(
          (yield* sql`SELECT 1 FROM scheduled_task_webhook_relay_deliveries`).length,
          13,
        );
        yield* TestClock.adjust("10 seconds");
        yield* drainPendingDispatch(workers);
        yield* Queue.take(launches);
        assert.equal((yield* sql`SELECT 1 FROM scheduled_task_webhook_replay_keys`).length, 0);
        assert.equal((yield* sql`SELECT 1 FROM scheduled_task_webhook_relay_deliveries`).length, 0);
        const retry = yield* service.triggerWebhook(request("B11"));
        assert.equal(retry._tag === "accepted" && retry.outcome, "accepted");
        yield* TestClock.adjust("10 seconds");
        yield* drainPendingDispatch(workers);
        assert.include((yield* Queue.take(launches)).initialMessage!.text, "B11");
        assert.equal((yield* service.list()).tasks[0]!.runCount, 2);
      }),
    { workers, failLaunches: { remaining: 1 } },
  );
});
it.effect(
  "recovery finishes failed-window claim cleanup without counting the attempt twice",
  () => {
    const workers = new Map<string, Effect.Effect<void>>();
    return withService(
      ({ service, sql, launches }) =>
        Effect.gen(function* () {
          const { task } = yield* service.upsert(
            yield* webhookTaskInput({
              schedule: {
                type: "webhook",
                dedupe: {
                  replayKey: "{{headers.delivery-id}}",
                  coalesceKey: "{{body}}",
                  coalesceWindowSeconds: 10,
                },
              },
            }),
          );
          const request = (id: string) =>
            requestFor(task, { headers: { "delivery-id": id }, relayDeliveryId: id });
          yield* service.triggerWebhook(request("A"));
          yield* service.triggerWebhook(request("B"));
          yield* sql`CREATE TRIGGER fail_claim_cleanup BEFORE DELETE ON scheduled_task_webhook_relay_deliveries
      BEGIN SELECT RAISE(FAIL, 'cleanup unavailable'); END`;
          yield* TestClock.adjust("10 seconds");
          yield* drainPendingDispatch(workers);
          yield* Queue.take(launches);
          assert.equal((yield* service.list()).tasks[0]!.runCount, 1);
          assert.equal(
            (yield* sql<{ state: string }>`SELECT state FROM scheduled_task_webhook_pending`)[0]!
              .state,
            "failed",
          );
          yield* sql`DROP TRIGGER fail_claim_cleanup`;
          const restartedWorkers = new Map<string, Effect.Effect<void>>();
          yield* withService(
            ({ service: restarted, launches: restartedLaunches }) =>
              Effect.gen(function* () {
                yield* drainPendingDispatch(restartedWorkers);
                assert.equal(yield* Queue.size(restartedLaunches), 0);
                assert.equal((yield* restarted.list()).tasks[0]!.runCount, 1);
                assert.equal((yield* sql`SELECT 1 FROM scheduled_task_webhook_pending`).length, 0);
                assert.equal(
                  (yield* sql`SELECT 1 FROM scheduled_task_webhook_replay_keys`).length,
                  0,
                );
                assert.equal(
                  (yield* sql`SELECT 1 FROM scheduled_task_webhook_relay_deliveries`).length,
                  0,
                );
                const retry = yield* restarted.triggerWebhook(request("B"));
                assert.equal(retry._tag === "accepted" && retry.outcome, "accepted");
                yield* TestClock.adjust("10 seconds");
                yield* drainPendingDispatch(restartedWorkers);
                yield* Queue.take(restartedLaunches);
                assert.equal((yield* restarted.list()).tasks[0]!.runCount, 2);
              }),
            { sql, workers: restartedWorkers },
          );
        }),
      { workers, failLaunches: { remaining: 1 } },
    );
  },
);
it.effect("dispatches an overdue window exactly once after its deadline passed while stopped", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const task = yield* withService(
      ({ service, launches }) =>
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
          assert.equal(yield* Queue.size(launches), 0);
          return task;
        }),
      { sql, workers: new Map() },
    );
    // The first service scope is closed before the deadline advances.
    yield* TestClock.adjust("30 seconds");
    const restartedWorkers = new Map<string, Effect.Effect<void>>();
    yield* withService(
      ({ service, launches }) =>
        Effect.gen(function* () {
          yield* drainPendingDispatch(restartedWorkers);
          yield* Queue.take(launches);
          for (let i = 0; i < 3; i++) yield* restartedWorkers.get("webhook-coalescing")!;
          assert.equal(yield* Queue.size(launches), 0);
          assert.equal((yield* service.list()).tasks[0]!.runCount, 1);
          assert.equal((yield* sql`SELECT 1 FROM scheduled_task_webhook_pending`).length, 0);
        }),
      { sql, workers: restartedWorkers },
    );
    const secondRestartWorkers = new Map<string, Effect.Effect<void>>();
    yield* withService(
      ({ service, launches }) =>
        Effect.gen(function* () {
          yield* secondRestartWorkers.get("webhook-coalescing")!;
          assert.equal(yield* Queue.size(launches), 0);
          assert.equal(
            (yield* service.list()).tasks.find((entry) => entry.id === task.id)!.runCount,
            1,
          );
        }),
      { sql, workers: secondRestartWorkers },
    );
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
it.effect("removes a window with a render defect and dispatches the task's next window", () => {
  const workers = new Map<string, Effect.Effect<void>>();
  return withService(
    ({ service, sql, launches }) =>
      Effect.gen(function* () {
        const { task } = yield* service.upsert(
          yield* webhookTaskInput({
            prompt: "{{body.deep}}",
            schedule: {
              type: "webhook",
              dedupe: {
                replayKey: "{{headers.delivery-id}}",
                coalesceKey: "{{headers.group}}",
                coalesceWindowSeconds: 10,
              },
            },
          }),
        );
        const request = (id: string, bodyText: string) =>
          requestFor(task, {
            bodyText,
            body: new TextEncoder().encode(bodyText),
            headers: { "delivery-id": id, group: id },
            relayDeliveryId: id,
          });
        const bad = request(
          "bad-render",
          '{"deep":' + "[".repeat(20000) + "0" + "]".repeat(20000) + "}",
        );
        assert.throws(() => renderWebhookPrompt(task.prompt, bad, "frame"), RangeError);
        const accepted = yield* service.triggerWebhook(bad);
        assert.equal(accepted._tag, "accepted");
        yield* service.triggerWebhook(request("good-render", '{"deep":"next window"}'));
        yield* TestClock.adjust("10 seconds");
        yield* drainPendingDispatch(workers);
        assert.include((yield* Queue.take(launches)).initialMessage!.text, "next window");
        assert.equal(yield* Queue.size(launches), 0);
        assert.equal((yield* sql`SELECT 1 FROM scheduled_task_webhook_pending`).length, 0);
        assert.equal(
          (yield* sql`SELECT 1 FROM scheduled_task_webhook_replay_keys WHERE delivery_id = 'delivery:relay:bad-render'`)
            .length,
          0,
        );
        assert.equal(
          (yield* sql`SELECT 1 FROM scheduled_task_webhook_relay_deliveries WHERE relay_delivery_id = 'bad-render'`)
            .length,
          0,
        );
        const failed = (yield* service.getWebhookDelivery({
          id: task.id,
          deliveryId: ScheduledTaskWebhookDeliveryId.make("delivery:relay:bad-render"),
          acceptAnyOutcome: true,
        })).delivery;
        assert.equal(failed.outcome, "dispatch_failed");
        assert.equal(failed.error, "The pending webhook payload could not be prepared.");
        yield* workers.get("webhook-coalescing")!;
        assert.equal((yield* service.list()).tasks[0]!.runCount, 1);
      }),
    { workers },
  );
});
it.effect.each([false, true])(
  "counts an interrupted immediate run beside an unrelated running window (corrupt task: %s)",
  (corrupt) => {
    const workers = new Map<string, Effect.Effect<void>>();
    const completedLaunches = new Set<string>();
    return Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      yield* withService(
        ({ service, sql, launches }) =>
          Effect.gen(function* () {
            const { task } = yield* service.upsert(
              yield* webhookTaskInput({
                prompt: "{{body.value}}",
                schedule: {
                  type: "webhook",
                  dedupe: { coalesceKey: "{{headers.group}}", coalesceWindowSeconds: 10 },
                },
              }),
            );
            const window = yield* service.triggerWebhook(
              requestFor(task, { headers: { group: "old" }, bodyText: '{"value":"old"}' }),
            );
            yield* sql`CREATE TRIGGER fail_old_completion BEFORE UPDATE ON scheduled_tasks
        WHEN NEW.last_run_status = 'succeeded' BEGIN SELECT RAISE(FAIL, 'completion unavailable'); END`;
            yield* TestClock.adjust("10 seconds");
            yield* drainPendingDispatch(workers);
            yield* Queue.take(launches);
            yield* sql`DROP TRIGGER fail_old_completion`;
            assert.equal(
              (yield* sql`SELECT 1 FROM scheduled_task_webhook_pending WHERE state = 'running'`)
                .length,
              1,
            );
            const immediate = yield* service.triggerWebhook(
              requestFor(task, { bodyText: '{"value":"immediate"}' }),
            );
            yield* Queue.take(launches);
            const [before] = yield* sql<{
              last_run_webhook_delivery_id: string;
              model_selection_json: string;
              run_count: number;
            }>`SELECT last_run_webhook_delivery_id, model_selection_json, run_count FROM scheduled_tasks WHERE task_id = ${task.id}`;
            assert.equal(
              before!.last_run_webhook_delivery_id,
              immediate._tag === "accepted" ? immediate.deliveryId : "",
            );
            assert.notEqual(
              before!.last_run_webhook_delivery_id,
              window._tag === "accepted" ? window.deliveryId : "",
            );
            assert.equal(before!.run_count, 0);
            if (corrupt)
              yield* sql`UPDATE scheduled_tasks SET model_selection_json = 'broken' WHERE task_id = ${task.id}`;
            const restartedWorkers = new Map<string, Effect.Effect<void>>();
            yield* withService(
              ({ service: restarted, launches: recoveredLaunches }) =>
                Effect.gen(function* () {
                  const [recovered] = yield* sql<{
                    run_count: number;
                    last_run_status: string;
                  }>`SELECT run_count, last_run_status FROM scheduled_tasks WHERE task_id = ${task.id}`;
                  assert.equal(recovered!.run_count, 1);
                  assert.equal(recovered!.last_run_status, "failed");
                  if (corrupt)
                    yield* sql`UPDATE scheduled_tasks SET model_selection_json = ${before!.model_selection_json} WHERE task_id = ${task.id}`;
                  yield* drainPendingDispatch(restartedWorkers);
                  assert.equal(yield* Queue.size(recoveredLaunches), 0);
                  assert.equal((yield* restarted.list()).tasks[0]!.runCount, 2);
                  assert.equal(
                    (yield* sql`SELECT 1 FROM scheduled_task_webhook_pending`).length,
                    0,
                  );
                  yield* restartedWorkers.get("webhook-coalescing")!;
                  assert.equal((yield* restarted.list()).tasks[0]!.runCount, 2);
                }),
              { sql, workers: restartedWorkers, completedLaunches },
            );
          }),
        {
          workers,
          completedLaunches,
          gateForTask: (input) =>
            input.initialMessage?.text.includes(">immediate<") ? gate : undefined,
        },
      );
    });
  },
);
it.effect("checks filters after the signature and max age, and runs only matching deliveries", () =>
  withService(({ service, launches }) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(
        yield* webhookTaskInput({
          schedule: {
            type: "webhook",
            signature: {
              header: "x-hub-signature-256",
              encoding: "hex",
              prefix: "sha256=",
              secret: "s3cret",
            },
            maxDeliveryAgeMinutes: 30,
            filters: [
              { path: "headers.x-github-event", op: "equals", value: "pull_request" },
              { path: "body.action", op: "in", value: ["opened", "reopened"] },
            ],
          },
        }),
      );
      const delivery = (
        event: string,
        action: string,
        options: { readonly signed?: boolean; readonly receivedAt?: string } = {},
      ) => {
        const body = new TextEncoder().encode(
          JSON.stringify({ action, pull_request: { url: "https://github.com/org/repo/pull/45" } }),
        );
        const signature = `sha256=${NodeCrypto.createHmac("sha256", "s3cret").update(body).digest("hex")}`;
        return requestFor(task, {
          headers: {
            "content-type": "application/json",
            "x-github-event": event,
            ...(options.signed === false ? {} : { "x-hub-signature-256": signature }),
          },
          body,
          bodyText: new TextDecoder().decode(body),
          ...(options.receivedAt === undefined
            ? {}
            : { relayDeliveryId: "old", receivedAt: options.receivedAt }),
        });
      };
      const now = yield* DateTime.now;
      const old = DateTime.formatIso(DateTime.subtract(now, { minutes: 31 }));

      // A request failing a filter is still refused first for its signature or age.
      const unsigned = yield* service.triggerWebhook(delivery("push", "opened", { signed: false }));
      assert.equal(unsigned._tag, "rejected_signature");
      const tooOld = yield* service.triggerWebhook(delivery("push", "opened", { receivedAt: old }));
      assert.equal(tooOld._tag, "expired");

      const wrongEvent = yield* service.triggerWebhook(delivery("push", "opened"));
      const wrongAction = yield* service.triggerWebhook(delivery("pull_request", "closed"));
      assert.deepInclude(wrongEvent, { _tag: "accepted", outcome: "filtered" });
      assert.deepInclude(wrongAction, { _tag: "accepted", outcome: "filtered" });
      assert.equal(yield* Queue.size(launches), 0);
      const [listed] = (yield* service.list()).tasks;
      assert.equal(listed?.runCount, 0);
      assert.equal(listed?.lastRunStatus, "never");

      const matched = yield* service.triggerWebhook(delivery("pull_request", "opened"));
      assert.deepInclude(matched, { _tag: "accepted", outcome: "accepted" });
      assert.include((yield* Queue.take(launches)).initialMessage?.text ?? "", "pull/45");

      const deliveries = (yield* service.listWebhookDeliveries({
        id: task.id,
        acceptAnyOutcome: true,
      })).deliveries;
      const filtered = deliveries
        .filter((entry) => entry.outcome === "filtered")
        .map((entry) => [entry.signatureVerified, entry.error]);
      assert.sameDeepMembers(filtered, [
        [true, "Filter 1 (headers.x-github-event) did not match."],
        [true, "Filter 2 (body.action) did not match."],
      ]);
    }),
  ),
);
