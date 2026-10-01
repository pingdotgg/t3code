import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import { ScheduledTaskUpsertInput } from "@t3tools/contracts";
import type { RelayWebhookDelivery } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";
import * as WebhookInboxClient from "./WebhookInboxClient.ts";

const decodeUpsertInput = Schema.decodeUnknownEffect(ScheduledTaskUpsertInput);

const taskInput = (overrides: Record<string, unknown>) =>
  decodeUpsertInput({
    title: "Investigate incoming events",
    prompt: "Investigate this event.",
    enabled: true,
    schedule: { type: "webhook" },
    projectId: "project-webhooks",
    workspaceStrategy: { type: "worktree", baseRef: "main" },
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    ...overrides,
  });

const delivery = (deliveryId: string, inboxId: string, body: string): RelayWebhookDelivery => ({
  deliveryId,
  inboxId,
  receivedAt: "2026-10-01T10:00:00.000Z",
  headers: { "content-type": "application/json", "sentry-hook-resource": "issue" },
  body,
});

/** In-memory relay inboxes, numbered in creation order. */
const makeRelay = Effect.gen(function* () {
  const created = yield* Ref.make(0);
  const removed = yield* Ref.make<ReadonlyArray<string>>([]);
  const layer = Layer.mock(WebhookInboxClient.WebhookInboxClient)({
    create: Ref.updateAndGet(created, (n) => n + 1).pipe(
      Effect.map((n) => ({
        inboxId: `inbox-${n}`,
        url: `https://relay.test/v1/inbox/inbox-${n}`,
        createdAt: "2026-10-01T09:00:00.000Z",
      })),
    ),
    remove: (inboxId) => Ref.update(removed, (all) => [...all, inboxId]),
  });
  return { created, removed, layer };
});

it.effect("keeps one webhook URL per task across edits and removes it when no longer needed", () =>
  Effect.gen(function* () {
    const relay = yield* makeRelay;
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const input = yield* taskInput({ id: "scheduled-task:webhook" });

      const created = (yield* service.upsert(input)).task;
      expect(created.schedule).toEqual({
        type: "webhook",
        inboxId: "inbox-1",
        url: "https://relay.test/v1/inbox/inbox-1",
      });
      expect(created.nextRunAt).toBeNull();

      const edited = (yield* service.upsert(yield* taskInput({ ...input, title: "Renamed" }))).task;
      expect(edited.schedule).toEqual(created.schedule);
      expect(yield* Ref.get(relay.created)).toBe(1);

      yield* service.upsert(
        yield* taskInput({ ...input, schedule: { type: "interval", everyMs: 60_000 } }),
      );
      expect(yield* Ref.get(relay.removed)).toEqual(["inbox-1"]);

      const relistening = (yield* service.upsert(input)).task;
      expect(relistening.schedule).toMatchObject({ type: "webhook", inboxId: "inbox-2" });

      yield* service.delete({ id: relistening.id });
      expect(yield* Ref.get(relay.removed)).toEqual(["inbox-1", "inbox-2"]);
    }).pipe(
      Effect.provide(
        ScheduledTaskService.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              NodeCrypto.layer,
              Scheduler.layer,
              Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
              Layer.mock(ThreadManagementService.ThreadManagementService)({}),
              relay.layer,
            ),
          ),
        ),
      ),
    );
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

const insertWebhookTask = (
  sql: SqlClient.SqlClient,
  task: { readonly id: string; readonly inboxId: string; readonly enabled: boolean },
) =>
  sql`INSERT INTO scheduled_tasks ${sql.insert({
    task_id: task.id,
    title: "Investigate incoming events",
    prompt: "Investigate this event.",
    enabled: task.enabled ? 1 : 0,
    schedule_json: JSON.stringify({
      type: "webhook",
      inboxId: task.inboxId,
      url: `https://relay.test/v1/inbox/${task.inboxId}`,
    }),
    project_id: "project-webhooks",
    thread_id: null,
    workspace_strategy_json: '{"type":"root"}',
    model_selection_json: '{"instanceId":"codex","model":"gpt-5.4"}',
    runtime_mode: "full-access",
    interaction_mode: "default",
    created_by: "user",
    creation_source: "web",
    created_at: "2026-10-01T09:00:00.000Z",
    updated_at: "2026-10-01T09:00:00.000Z",
    next_run_at: null,
    last_run_at: null,
    last_run_status: "never",
    last_run_error: null,
    run_count: 0,
  })}`;

it.effect(
  "starts one run per pushed delivery keyed on the delivery, and drops deliveries for paused or deleted tasks",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* insertWebhookTask(sql, {
        id: "scheduled-task:listening",
        inboxId: "inbox-1",
        enabled: true,
      });
      yield* insertWebhookTask(sql, {
        id: "scheduled-task:paused",
        inboxId: "inbox-2",
        enabled: false,
      });
      const relay = yield* makeRelay;
      const launches = yield* Ref.make<ReadonlyArray<ThreadLaunchService.ThreadLaunchInput>>([]);
      const dependencies = Layer.mergeAll(
        NodeCrypto.layer,
        Scheduler.layer,
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({
          launch: (input) =>
            Ref.update(launches, (all) => [...all, input]).pipe(
              Effect.andThen(
                input.initialMessage?.text.includes("fail-me")
                  ? Effect.die(new Error("launch failed"))
                  : Effect.succeed({} as ThreadLaunchService.ThreadLaunchResult),
              ),
            ),
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({}),
        relay.layer,
      );
      yield* Effect.gen(function* () {
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        const issue = delivery(
          "delivery-1",
          "inbox-1",
          '{"action":"created","data":{"issue":{"id":"42"}}}',
        );

        expect(yield* service.acceptWebhookDelivery(issue)).toBe("started");
        // A redelivery replays the same command, which the orchestrator dedupes.
        expect(yield* service.acceptWebhookDelivery(issue)).toBe("started");
        expect(
          yield* service.acceptWebhookDelivery(
            delivery("delivery-2", "inbox-1", '{"note":"fail-me"}'),
          ),
        ).toBe("started");
        expect(yield* service.acceptWebhookDelivery(delivery("delivery-3", "inbox-2", "{}"))).toBe(
          "dropped",
        );
        expect(
          yield* service.acceptWebhookDelivery(delivery("delivery-4", "inbox-gone", "{}")),
        ).toBe("dropped");

        const launched = yield* Ref.get(launches);
        expect(launched.map((input) => input.commandId)).toEqual([
          "scheduled-task:scheduled-task:listening:delivery:delivery-1",
          "scheduled-task:scheduled-task:listening:delivery:delivery-1",
          "scheduled-task:scheduled-task:listening:delivery:delivery-2",
        ]);
        const text = launched[0]?.initialMessage?.text ?? "";
        expect(text.startsWith("Investigate this event.")).toBe(true);
        expect(text).toContain("sentry-hook-resource: issue");
        expect(text).toContain('{"action":"created","data":{"issue":{"id":"42"}}}');
        expect(launched[0]?.initialMessage?.scheduledTaskId).toBe("scheduled-task:listening");

        // A failed launch is recorded on the task rather than bounced back to the relay.
        const listening = (yield* service.list()).tasks.find(
          (task) => task.id === "scheduled-task:listening",
        );
        expect(listening?.lastRunStatus).toBe("failed");
        expect(listening?.runCount).toBe(3);
      }).pipe(Effect.provide(ScheduledTaskService.layer.pipe(Layer.provide(dependencies))));
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
