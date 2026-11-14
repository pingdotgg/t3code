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

it.effect(
  "preserves omitted dedupe settings, releases duplicate claims, and retains coalesced claims",
  () =>
    withService(({ service, sql, launches }) =>
      Effect.gen(function* () {
        const dedupe = {
          replayKey: "{{headers.delivery-id}}",
          coalesceKey: "{{body.group}}",
          coalesceWindowSeconds: 10,
        };
        const { task } = yield* service.upsert(
          yield* webhookTaskInput({ schedule: { type: "webhook", dedupe } }),
        );
        const updated = yield* service.upsert(yield* webhookTaskInput());
        assert.deepEqual(
          updated.task.schedule.type === "webhook" && updated.task.schedule.dedupe,
          dedupe,
        );
        const request = (id: string, bodyText = "{}", relayDeliveryId?: string) =>
          requestFor(task, {
            headers: { "delivery-id": id },
            bodyText,
            body: new TextEncoder().encode(bodyText),
            ...(relayDeliveryId === undefined ? {} : { relayDeliveryId }),
          });
        yield* service.triggerWebhook(request("A"));
        yield* Queue.take(launches);
        yield* service.triggerWebhook(request("B1", '{"group":"B"}'));
        for (let i = 0; i < 5; i++) {
          const duplicate = yield* service.triggerWebhook(request("A", "{}", `duplicate-${i}`));
          assert.equal(duplicate._tag === "accepted" && duplicate.outcome, "duplicate");
          const coalesced = yield* service.triggerWebhook(
            request(`B${i + 2}`, '{"group":"B"}', `coalesced-${i}`),
          );
          assert.equal(coalesced._tag === "accepted" && coalesced.outcome, "coalesced");
        }
        const claims = yield* sql<{
          relay_delivery_id: string;
        }>`SELECT relay_delivery_id FROM scheduled_task_webhook_relay_deliveries ORDER BY relay_delivery_id`;
        assert.deepEqual(
          claims.map((claim) => claim.relay_delivery_id),
          Array.from({ length: 5 }, (_, i) => `coalesced-${i}`),
        );
        assert.isTrue(
          (yield* service.listWebhookDeliveries({ id: task.id })).deliveries.every(
            (delivery) => delivery.outcome !== "duplicate" && delivery.outcome !== "coalesced",
          ),
        );
        const fresh = yield* service.triggerWebhook(request("C", "{}", "duplicate-0"));
        assert.equal(fresh._tag === "accepted" && fresh.outcome, "accepted");
        yield* Queue.take(launches);
        const cleared = yield* service.upsert(
          yield* webhookTaskInput({ schedule: { type: "webhook", dedupe: {} } }),
        );
        assert.deepEqual(
          cleared.task.schedule.type === "webhook" && cleared.task.schedule.dedupe,
          {},
        );
      }),
    ),
);
it.effect("dispatches exactly the rendered prompt and logs the delivery", () =>
  withService(({ service, launches }) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(yield* webhookTaskInput());
      assert.equal(task.nextRunAt, null);
      assert.isDefined(task.webhook);
      assert.isTrue(task.webhook!.path.startsWith("/api/hooks/scheduled-task%3Ahook/"));
      assert.equal(task.webhook!.url, null);

      const result = yield* service.triggerWebhook(requestFor(task));
      assert.equal(result._tag, "accepted");
      const launched = yield* Queue.take(launches);
      const framed =
        /^Review this PR: <(webhook-data-[0-9a-f]{12})>https:\/\/github\.com\/org\/repo\/pull\/45<\/\1>\n\nText between <\1> and <\/\1> was copied from the webhook request\./;
      const frame = framed.exec(launched.initialMessage?.text ?? "")?.[1];
      assert.isDefined(frame);
      assert.equal(
        launched.commandId,
        `scheduled-task:${task.id}:webhook:${result._tag === "accepted" ? result.deliveryId : ""}`,
      );

      const { deliveries } = yield* service.listWebhookDeliveries({
        id: task.id,
        acceptAnyOutcome: true,
      });
      assert.equal(deliveries.length, 1);
      assert.equal(deliveries[0]?.outcome, "accepted");
      const { delivery } = yield* service.getWebhookDelivery({
        id: task.id,
        deliveryId: deliveries[0]!.id,
      });
      assert.equal(delivery.body, new TextDecoder().decode(pullRequestBody));
      assert.equal(delivery.renderedPrompt, launched.initialMessage?.text);

      yield* service.triggerWebhook(requestFor(task));
      const next = framed.exec((yield* Queue.take(launches)).initialMessage?.text ?? "")?.[1];
      assert.isDefined(next);
      assert.notEqual(next, frame);
    }),
  ),
);
it("builds the relay hook URL from the managed tunnel's key, never the environment id", () => {
  const relayUrl = "https://relay.example.com/";
  assert.equal(
    ScheduledTaskService.relayHookBaseUrl({
      relayUrl,
      tunnelName: "t3coderelay-managedendpoint-dev-julius-0123456789abcdef",
    }),
    "https://relay.example.com/v1/hooks/0123456789abcdef",
  );
  for (const tunnelName of [undefined, "t3coderelay-managedendpoint", "x-0123456789ABCDEF"]) {
    assert.isNull(ScheduledTaskService.relayHookBaseUrl({ relayUrl, tunnelName }));
  }
});
it.effect("gives webhook tasks a relay URL when the environment has a managed tunnel", () =>
  withService(
    ({ service }) =>
      Effect.gen(function* () {
        const { task } = yield* service.upsert(yield* webhookTaskInput());
        const token = task.webhook!.path.split("/").at(-1);
        assert.equal(
          task.webhook?.url,
          `https://relay.example.com/v1/hooks/0123456789abcdef/scheduled-task%3Ahook/${token}`,
        );
      }),
    { relayHookBaseUrl: "https://relay.example.com/v1/hooks/0123456789abcdef" },
  ),
);
it.effect("answers not found for a wrong token or unknown hook without logging", () =>
  withService(({ service }) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(yield* webhookTaskInput());
      const wrongToken = yield* service.triggerWebhook(requestFor(task, { token: "nope" }));
      assert.equal(wrongToken._tag, "not_found");
      const unknown = yield* service.triggerWebhook(requestFor(task, { hookId: "missing" }));
      assert.equal(unknown._tag, "not_found");
      assert.equal(
        (yield* service.listWebhookDeliveries({ id: task.id, acceptAnyOutcome: true })).deliveries
          .length,
        0,
      );
    }),
  ),
);
it.effect("rotating the token retires the old URL and saving keeps it", () =>
  withService(({ service }) =>
    Effect.gen(function* () {
      const input = yield* webhookTaskInput();
      const { task } = yield* service.upsert(input);
      const saved = yield* service.upsert(yield* webhookTaskInput({ title: "Renamed" }));
      assert.equal(saved.task.webhook?.path, task.webhook?.path);

      const rotated = yield* service.rotateWebhookToken({ id: task.id });
      assert.notEqual(rotated.task.webhook?.path, task.webhook?.path);
      assert.equal((yield* service.triggerWebhook(requestFor(task)))._tag, "not_found");
      assert.equal((yield* service.triggerWebhook(requestFor(rotated.task)))._tag, "accepted");
    }),
  ),
);
it.effect("checks the configured signature and keeps the secret write-only", () =>
  withService(({ service }) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(
        yield* webhookTaskInput({
          schedule: {
            type: "webhook",
            signature: {
              header: "X-Hub-Signature-256",
              encoding: "hex",
              prefix: "sha256=",
              secret: "s3cret",
            },
          },
        }),
      );
      assert.deepEqual(task.schedule, {
        type: "webhook",
        signature: { header: "x-hub-signature-256", encoding: "hex", prefix: "sha256=" },
        maxDeliveryAgeMinutes: null,
      });
      assert.isTrue(task.webhook?.hasSecret);

      const unsigned = yield* service.triggerWebhook(requestFor(task));
      assert.equal(unsigned._tag, "rejected_signature");

      const signature = `sha256=${NodeCrypto.createHmac("sha256", "s3cret").update(pullRequestBody).digest("hex")}`;
      const signed = yield* service.triggerWebhook(
        requestFor(task, {
          headers: { "content-type": "application/json", "x-hub-signature-256": signature },
        }),
      );
      assert.equal(signed._tag, "accepted");

      const resaved = yield* service.upsert(
        yield* webhookTaskInput({
          schedule: {
            type: "webhook",
            signature: { header: "x-hub-signature-256", encoding: "hex", prefix: "sha256=" },
          },
        }),
      );
      assert.isTrue(resaved.task.webhook?.hasSecret);

      const outcomes = (yield* service.listWebhookDeliveries({
        id: task.id,
        acceptAnyOutcome: true,
      })).deliveries.map((delivery) => [delivery.outcome, delivery.signatureVerified]);
      assert.deepEqual(outcomes.toSorted(), [
        ["accepted", true],
        ["rejected_signature", false],
      ]);
    }),
  ),
);
it.effect("a policy without webhook tasks keeps existing ones but refuses saves and requests", () =>
  withService(({ service, sql }) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(yield* webhookTaskInput());
      const timer = yield* webhookTaskInput({
        id: "scheduled-task:timer",
        schedule: { type: "interval", everyMs: 3_600_000 },
      });
      yield* withService(
        ({ service, launches }) =>
          Effect.gen(function* () {
            const blocked = "Example Corp's policy does not allow webhook tasks.";
            const listed = (yield* service.list()).tasks.find(({ id }) => id === task.id);
            assert.equal(listed?.blockedByPolicy, blocked);
            assert.isTrue(listed?.enabled);

            const refused = yield* service.upsert(yield* webhookTaskInput()).pipe(Effect.flip);
            assert.equal(refused.message, blocked);
            const created = yield* service
              .upsert(yield* webhookTaskInput({ id: "scheduled-task:new-hook" }))
              .pipe(Effect.flip);
            assert.equal(created.message, blocked);

            // Turned off, it can still be edited, but not turned back on.
            yield* service.setEnabled({ id: task.id, enabled: false });
            yield* service.upsert(yield* webhookTaskInput({ enabled: false }));
            const reenabled = yield* service
              .setEnabled({ id: task.id, enabled: true })
              .pipe(Effect.flip);
            assert.equal(reenabled.message, blocked);

            const result = yield* service.triggerWebhook(requestFor(task));
            assert.equal(result._tag, "blocked_by_policy");
            assert.equal(yield* Queue.size(launches), 0);
            assert.equal((yield* sql`SELECT * FROM scheduled_task_webhook_deliveries`).length, 0);

            // Timer tasks are unaffected, including a webhook task switched to a timer.
            assert.isUndefined((yield* service.upsert(timer)).task.blockedByPolicy);
            const switched = yield* service.upsert(
              yield* webhookTaskInput({ schedule: { type: "interval", everyMs: 3_600_000 } }),
            );
            assert.isUndefined(switched.task.blockedByPolicy);
          }),
        {
          sql,
          policy: {
            schemaVersion: 1,
            organization: "Example Corp",
            limits: { webhookTasks: false },
          },
        },
      );
    }),
  ),
);
it.effect("logs but does not run deliveries to a disabled task, and refuses run now", () =>
  withService(({ service, launches }) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(yield* webhookTaskInput({ enabled: false }));
      assert.equal((yield* service.triggerWebhook(requestFor(task)))._tag, "disabled");
      assert.equal(yield* Queue.size(launches), 0);
      const runNow = yield* service.runNow({ id: task.id }).pipe(Effect.flip);
      assert.equal(runNow.message, "Webhook tasks run when their URL receives a request.");
    }),
  ),
);
it.effect("a save carrying a stale token cannot undo a rotation", () =>
  withService(({ service }) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(yield* webhookTaskInput());
      const rotated = yield* service.rotateWebhookToken({ id: task.id });
      const saved = yield* service.upsert(yield* webhookTaskInput({ title: "Edited" }));
      assert.equal(saved.task.webhook?.path, rotated.task.webhook?.path);
      assert.equal((yield* service.triggerWebhook(requestFor(task)))._tag, "not_found");
    }),
  ),
);
it.effect("keeps credential headers and query values out of the delivery log", () =>
  withService(({ service }) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(yield* webhookTaskInput({ enabled: false }));
      yield* service.triggerWebhook(
        requestFor(task, {
          query: "page=2&api_key=k",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer sender-token",
            "x-webhook-key": "k",
            "x-github-event": "push",
          },
        }),
      );
      const [summary] = (yield* service.listWebhookDeliveries({
        id: task.id,
        acceptAnyOutcome: true,
      })).deliveries;
      const { delivery } = yield* service.getWebhookDelivery({
        id: task.id,
        deliveryId: summary!.id,
      });
      assert.equal(delivery.query, "page=2&api_key=[redacted]");
      assert.equal(delivery.headers.authorization, "[redacted]");
      assert.equal(delivery.headers["x-webhook-key"], "[redacted]");
      assert.equal(delivery.headers["x-github-event"], "push");
    }),
  ),
);
it.effect("drops a character split by the delivery log's body limit", () =>
  withService(({ service }) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(yield* webhookTaskInput({ enabled: false }));
      const limit = 64 * 1024;
      const euro = new TextEncoder().encode("€");
      const body = new Uint8Array(limit - 1 + euro.length).fill(0x61);
      body.set(euro, limit - 1);
      yield* service.triggerWebhook(
        requestFor(task, { body, bodyText: new TextDecoder().decode(body) }),
      );
      const [summary] = (yield* service.listWebhookDeliveries({
        id: task.id,
        acceptAnyOutcome: true,
      })).deliveries;
      const { delivery } = yield* service.getWebhookDelivery({
        id: task.id,
        deliveryId: summary!.id,
      });
      assert.isTrue(delivery.bodyTruncated);
      assert.equal(delivery.bodyBytes, body.byteLength);
      assert.equal(delivery.body.slice(-3), "aaa");
      assert.equal(delivery.body.length, limit - 1);
    }),
  ),
);
it.effect.each(queuedDeliveryCases)(
  "a delivery queued behind a run does not start once the task is $change",
  ({ reason, apply }) =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const deliveryReleased = yield* Deferred.make<void>();
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          const end = span.end.bind(span);
          span.end = (...args) => {
            end(...args);
            if (span.name === "ScheduledTaskService.releaseFailedDelivery") {
              Deferred.doneUnsafe(deliveryReleased, Effect.void);
            }
          };
          return span;
        },
      });
      yield* withService(
        ({ service, launches }) =>
          Effect.gen(function* () {
            const { task } = yield* service.upsert(yield* webhookTaskInput());
            yield* service.triggerWebhook(requestFor(task));
            const queued = yield* service.triggerWebhook(requestFor(task));
            yield* Queue.take(launches);
            yield* apply(service, task.id);
            yield* Deferred.succeed(gate, undefined);
            const deliveryId = queued._tag === "accepted" ? queued.deliveryId : undefined;
            yield* Deferred.await(deliveryReleased);
            const delivery = (yield* service.getWebhookDelivery({
              id: task.id,
              deliveryId: deliveryId!,
            })).delivery;
            assert.equal(delivery.outcome, "dispatch_failed");
            assert.equal(delivery.error, reason);
            assert.equal(yield* Queue.size(launches), 0);
          }),
        { gate },
      ).pipe(Effect.withTracer(tracer));
    }),
);
it.effect("a save without a secret keeps a secret changed after it was read", () =>
  withService(({ service }) =>
    Effect.gen(function* () {
      const signature = { header: "x-hub-signature-256", encoding: "hex", prefix: "sha256=" };
      const { task } = yield* service.upsert(
        yield* webhookTaskInput({
          schedule: { type: "webhook", signature: { ...signature, secret: "old" } },
        }),
      );
      yield* service.upsert(
        yield* webhookTaskInput({
          schedule: { type: "webhook", signature: { ...signature, secret: "new" } },
        }),
      );
      yield* service.upsert(
        yield* webhookTaskInput({ title: "Edited", schedule: { type: "webhook", signature } }),
      );
      const sign = (secret: string) =>
        `sha256=${NodeCrypto.createHmac("sha256", secret).update(pullRequestBody).digest("hex")}`;
      const withSignature = (secret: string) =>
        requestFor(task, {
          headers: { "content-type": "application/json", "x-hub-signature-256": sign(secret) },
        });
      assert.equal(
        (yield* service.triggerWebhook(withSignature("old")))._tag,
        "rejected_signature",
      );
      assert.equal((yield* service.triggerWebhook(withSignature("new")))._tag, "accepted");
    }),
  ),
);
it.effect("a held request already delivered directly runs only once", () =>
  withService(({ service, launches }) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(yield* webhookTaskInput());
      const direct = yield* service.triggerWebhook(
        requestFor(task, { relayDeliveryId: "relay-1" }),
      );
      const replayed = yield* service.triggerWebhook(
        requestFor(task, { relayDeliveryId: "relay-1", receivedAt: "2026-10-04T10:00:00.000Z" }),
      );
      assert.equal(direct._tag, "accepted");
      assert.deepEqual(replayed, { ...direct, outcome: "duplicate" } as typeof replayed);
      yield* Queue.take(launches);
      const logged = (yield* service.listWebhookDeliveries({ id: task.id, acceptAnyOutcome: true }))
        .deliveries;
      assert.equal(logged.length, 1);
    }),
  ),
);
it.effect("relay retries recover failed acceptance without releasing another request's claim", () =>
  withService(({ service, launches, sql }) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(yield* webhookTaskInput());
      const request = requestFor(task, { relayDeliveryId: "retry-after-log-failure" });
      yield* sql`
        CREATE TRIGGER fail_webhook_delivery_log
        BEFORE INSERT ON scheduled_task_webhook_deliveries
        BEGIN
          SELECT RAISE(FAIL, 'injected delivery log failure');
        END
      `;
      const error = yield* service.triggerWebhook(request).pipe(Effect.flip);
      assert.equal(error.message, "Could not record webhook delivery.");
      assert.equal(yield* Queue.size(launches), 0);
      assert.isEmpty(
        (yield* service.listWebhookDeliveries({ id: task.id, acceptAnyOutcome: true })).deliveries,
      );
      yield* sql`DROP TRIGGER fail_webhook_delivery_log`;

      const retried = yield* Effect.all(
        [service.triggerWebhook(request), service.triggerWebhook(request)],
        { concurrency: "unbounded" },
      );
      assert.deepEqual(
        retried.map((result) => (result._tag === "accepted" ? result.outcome : result._tag)).sort(),
        ["accepted", "duplicate"],
      );
      assert.include((yield* Queue.take(launches)).commandId, request.relayDeliveryId!);

      yield* sql`
        CREATE TRIGGER fail_webhook_claim
        BEFORE INSERT ON scheduled_task_webhook_relay_deliveries
        BEGIN
          SELECT RAISE(FAIL, 'injected claim failure');
        END
      `;
      const retryError = yield* service.triggerWebhook(request).pipe(Effect.flip);
      assert.equal(retryError.message, "Could not record webhook delivery.");
      yield* sql`DROP TRIGGER fail_webhook_claim`;
      const replayed = yield* service.triggerWebhook(request);
      assert.equal(replayed._tag === "accepted" ? replayed.outcome : replayed._tag, "duplicate");
      assert.equal(yield* Queue.size(launches), 0);
      assert.equal(
        (yield* service.listWebhookDeliveries({ id: task.id, acceptAnyOutcome: true })).deliveries
          .length,
        1,
      );
    }),
  ),
);
it.effect("a held request whose sender hung up mid-request still runs", () =>
  withService(({ service, launches }) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(yield* webhookTaskInput());
      for (let step = 0; step < 60; step++) {
        const request = requestFor(task, { relayDeliveryId: `hung-up-${step}` });
        const fiber = yield* service
          .triggerWebhook(request)
          .pipe(Effect.provideService(EffectScheduler.MaxOpsBeforeYield, 8), Effect.forkChild);
        for (let yields = 0; yields < step; yields++) yield* Effect.yieldNow;
        yield* Fiber.interrupt(fiber);
        const retried = yield* service.triggerWebhook(request);
        assert.equal(retried._tag, "accepted");
        const deliveryId = retried._tag === "accepted" ? retried.deliveryId : undefined;
        yield* service.getWebhookDelivery({ id: task.id, deliveryId: deliveryId! });
        const launch = yield* Queue.take(launches);
        assert.include(launch.commandId, `hung-up-${step}`);
        yield* TestClock.adjust("61 seconds");
      }
      assert.equal(yield* Queue.size(launches), 0);
    }),
  ),
);
it.effect("a held request runs once even after the log has trimmed it", () =>
  withService(({ service, launches }) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(yield* webhookTaskInput());
      const first = yield* service.triggerWebhook(requestFor(task, { relayDeliveryId: "kept" }));
      assert.equal(first._tag, "accepted");
      yield* Queue.take(launches);
      const paused = yield* service.upsert(yield* webhookTaskInput({ enabled: false }));
      yield* Effect.forEach(Array.from({ length: 55 }), () =>
        service.triggerWebhook(requestFor(paused.task)),
      );
      yield* service.upsert(yield* webhookTaskInput());
      const replay = yield* service.triggerWebhook(requestFor(task, { relayDeliveryId: "kept" }));
      assert.equal(replay._tag, "accepted");
      assert.equal(yield* Queue.size(launches), 0);
    }),
  ),
);
it.effect("skips a held request older than the task's max age", () =>
  withService(({ service, launches }) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(
        yield* webhookTaskInput({ schedule: { type: "webhook", maxDeliveryAgeMinutes: 30 } }),
      );
      const now = yield* DateTime.now;
      const old = DateTime.formatIso(DateTime.subtract(now, { minutes: 31 }));
      const fresh = DateTime.formatIso(DateTime.subtract(now, { minutes: 5 }));
      const tooOld = yield* service.triggerWebhook(
        requestFor(task, { relayDeliveryId: "old", receivedAt: old }),
      );
      assert.equal(tooOld._tag, "expired");
      assert.equal(yield* Queue.size(launches), 0);
      const ok = yield* service.triggerWebhook(
        requestFor(task, { relayDeliveryId: "fresh", receivedAt: fresh }),
      );
      assert.equal(ok._tag, "accepted");
      const outcomes = (yield* service.listWebhookDeliveries({
        id: task.id,
        acceptAnyOutcome: true,
      })).deliveries.map((delivery) => delivery.outcome);
      assert.includeMembers(outcomes, ["expired", "accepted"]);
    }),
  ),
);

it.effect("a signature can take the user's secret by ref, which works only once", () =>
  withService(({ service, launches, secretsByRef }) =>
    Effect.gen(function* () {
      secretsByRef.set("secret-ref:00000000000000000000000000000001", "github-secret");
      const githubSchedule = (secretRef: string) => ({
        type: "webhook",
        signature: { header: "x-hub-signature-256", encoding: "hex", prefix: "sha256=", secretRef },
      });
      const { task } = yield* service.upsert(
        yield* webhookTaskInput({
          schedule: githubSchedule("secret-ref:00000000000000000000000000000001"),
        }),
      );
      assert.isTrue(task.webhook!.hasSecret);
      const signed = yield* service.triggerWebhook(
        requestFor(task, {
          headers: {
            "content-type": "application/json",
            "x-hub-signature-256": githubSignature("github-secret"),
          },
        }),
      );
      assert.equal(signed._tag, "accepted");
      yield* Queue.take(launches);

      const reused = yield* service
        .upsert(
          yield* webhookTaskInput({
            id: "scheduled-task:other",
            schedule: githubSchedule("secret-ref:00000000000000000000000000000001"),
          }),
        )
        .pipe(Effect.flip);
      assert.include(reused.message, "already used");
    }),
  ),
);
