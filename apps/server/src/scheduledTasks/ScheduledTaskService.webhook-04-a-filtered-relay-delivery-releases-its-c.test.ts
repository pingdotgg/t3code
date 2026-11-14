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
it.effect("a filtered relay delivery releases its claim, so a redelivery is evaluated again", () =>
  withService(({ service, launches }) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(yield* pullRequestFilterInput());
      const held = { relayDeliveryId: "relay-filtered" };
      const first = yield* service.triggerWebhook(
        requestFor(task, { ...held, ...githubEvent("push") }),
      );
      const again = yield* service.triggerWebhook(
        requestFor(task, { ...held, ...githubEvent("push") }),
      );
      assert.deepInclude(first, { _tag: "accepted", outcome: "filtered" });
      assert.deepInclude(again, { _tag: "accepted", outcome: "filtered" });
      const ran = yield* service.triggerWebhook(
        requestFor(task, { ...held, ...githubEvent("pull_request") }),
      );
      assert.deepInclude(ran, { _tag: "accepted", outcome: "accepted" });
      yield* Queue.take(launches);
      const replayed = yield* service.triggerWebhook(
        requestFor(task, { ...held, ...githubEvent("pull_request") }),
      );
      assert.deepInclude(replayed, { _tag: "accepted", outcome: "duplicate" });
    }),
  ),
);
it.effect("leaves filtered rows out of the list for clients that only decode older outcomes", () =>
  withService(({ service, launches }) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(yield* pullRequestFilterInput());
      yield* service.triggerWebhook(requestFor(task, githubEvent("push")));
      yield* service.triggerWebhook(requestFor(task, githubEvent("pull_request")));
      yield* Queue.take(launches);
      const legacy = (yield* service.listWebhookDeliveries({ id: task.id })).deliveries;
      assert.deepEqual(
        legacy.map((delivery) => delivery.outcome),
        ["accepted"],
      );
      const current = (yield* service.listWebhookDeliveries({
        id: task.id,
        acceptAnyOutcome: true,
      })).deliveries;
      assert.sameMembers(
        current.map((delivery) => delivery.outcome),
        ["accepted", "filtered"],
      );
    }),
  ),
);
it.effect("filters run before replay and coalescing without claiming ignored deliveries", () => {
  const workers = new Map<string, Effect.Effect<void>>();
  return withService(
    ({ service, launches, sql }) =>
      Effect.gen(function* () {
        const { task } = yield* service.upsert(
          yield* webhookTaskInput({
            prompt: "{{body.value}}",
            schedule: {
              type: "webhook",
              filters: [{ path: "body.run", op: "equals", value: "true" }],
              dedupe: {
                replayKey: "{{headers.delivery-id}}",
                coalesceKey: "{{body.group}}",
                coalesceWindowSeconds: 10,
              },
            },
          }),
        );
        const request = (id: string, run: boolean, value: string) => {
          const bodyText = JSON.stringify({ run, group: "B", value });
          return requestFor(task, {
            headers: { "delivery-id": id },
            bodyText,
            body: new TextEncoder().encode(bodyText),
            relayDeliveryId: id,
          });
        };
        const ignored = yield* service.triggerWebhook(request("A", false, "ignored"));
        assert.deepInclude(ignored, { _tag: "accepted", outcome: "filtered" });
        assert.equal((yield* sql`SELECT 1 FROM scheduled_task_webhook_replay_keys`).length, 0);
        assert.equal((yield* sql`SELECT 1 FROM scheduled_task_webhook_pending`).length, 0);
        assert.equal((yield* sql`SELECT 1 FROM scheduled_task_webhook_relay_deliveries`).length, 0);
        const filteredId = ignored._tag === "accepted" ? ignored.deliveryId : assert.fail();
        const oldClient = yield* service
          .getWebhookDelivery({ id: task.id, deliveryId: filteredId })
          .pipe(Effect.result);
        assert.equal(oldClient._tag, "Failure");
        const currentClient = yield* service.getWebhookDelivery({
          id: task.id,
          deliveryId: filteredId,
          acceptAnyOutcome: true,
        });
        assert.equal(currentClient.delivery.outcome, "filtered");
        assert.deepInclude(yield* service.triggerWebhook(request("A", true, "first")), {
          _tag: "accepted",
          outcome: "accepted",
        });
        assert.deepInclude(
          yield* service.triggerWebhook({
            ...request("A", false, "ignored replay"),
            relayDeliveryId: "ignored-replay",
          }),
          { _tag: "accepted", outcome: "filtered" },
        );
        assert.deepInclude(yield* service.triggerWebhook(request("B", false, "ignored update")), {
          _tag: "accepted",
          outcome: "filtered",
        });
        assert.deepInclude(yield* service.triggerWebhook(request("B", true, "latest")), {
          _tag: "accepted",
          outcome: "coalesced",
        });
        yield* TestClock.adjust("10 seconds");
        yield* drainPendingDispatch(workers);
        assert.include((yield* Queue.take(launches)).initialMessage!.text, "latest");
        assert.equal(yield* Queue.size(launches), 0);
      }),
    { workers },
  );
});
