import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import { ScheduledTaskUpsertInput, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";

const decodeInput = Schema.decodeUnknownEffect(ScheduledTaskUpsertInput);

it.effect.each([
  { status: "completed", change: "none", removed: true },
  { status: "completed", change: "legacy", removed: false },
  { status: "completed", change: "unrelated", removed: false },
  { status: "completed", change: "restart", removed: true },
  { status: "completed", change: "bound", removed: true },
  { status: "completed", change: "dispatch-failure", removed: false },
  { status: "running", change: "none", removed: false },
  { status: "queued", change: "none", removed: false },
  { status: "failed", change: "none", removed: false },
  { status: "interrupted", change: "none", removed: false },
  { status: "cancelled", change: "none", removed: false },
  { status: "completed", change: "reschedule", removed: false },
  { status: "completed", change: "replace", removed: false },
  { status: "completed", change: "early", removed: false },
  { status: "completed", change: "early-paused", removed: false },
  { status: "completed", change: "interval", removed: false },
  { status: "completed", change: "webhook", removed: false },
] as const)(
  "cleans one-off $status runs with $change edits: $removed",
  ({ status, change, removed }) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const sources = new Map<string, Effect.Effect<void>>();
      const messages: string[] = [];
      const register: Scheduler.Scheduler["Service"]["register"] = <E, R>(
        name: string,
        work: Effect.Effect<void, E, R>,
      ) =>
        Effect.gen(function* () {
          const context = yield* Effect.context<R>();
          sources.set(name, work.pipe(Effect.provideContext(context), Effect.orDie));
        });
      const dependencies = Layer.mergeAll(
        NodeCrypto.layer,
        ManagedPolicy.layerTest(),
        Layer.succeed(Scheduler.Scheduler, { register }),
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({
          launch: (input) => {
            if (change === "dispatch-failure") return Effect.die("dispatch failed");
            messages.push(input.initialMessage!.messageId!);
            return Effect.succeed({ threadId: ThreadId.make("cleanup-thread") } as never);
          },
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadShell: () =>
            Effect.succeed({
              projectId: "cleanup-project",
              deletedAt: null,
              archivedAt: null,
            } as never),
          sendToThread: (input) => {
            messages.push(input.messageId);
            return Effect.succeed({} as never);
          },
        }),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          namedProjectsRoot: "/projects",
          isScratchProject: () => Effect.succeed(false),
        }),
        Layer.mock(SecretRequests.SecretRequests)({}),
      );
      yield* TestClock.setTime(Date.parse("2026-11-01T07:59:00.000Z"));
      const serviceLayer = ScheduledTaskService.layer.pipe(Layer.provide(dependencies));
      yield* Effect.gen(function* () {
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        const input = yield* decodeInput({
          commandId: "cleanup-once",
          title: "One-off follow-up",
          prompt: "Report results",
          enabled: true,
          schedule: { type: "once", runAt: "2026-11-01T08:00:00.000Z" },
          projectId: "cleanup-project",
          threadMode: change === "bound" ? "continue" : "new_thread",
          ...(change === "bound" ? { threadId: "cleanup-thread" } : {}),
          workspaceStrategy: { type: "root" },
          modelSelection: { instanceId: "codex", model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
        });
        const { task } = yield* service.upsert(input);
        if (change !== "early" && change !== "early-paused")
          yield* TestClock.setTime(Date.parse("2026-11-01T08:00:00.000Z"));
        yield* service.runNow({ id: task.id });
        expect((yield* service.list()).tasks).toHaveLength(1);
        yield* sql`INSERT INTO orchestration_v2_projection_runs
        (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
        VALUES ('cleanup-run', 'cleanup-thread', 1, 'codex', ${status}, '2026-11-01T08:00:00.000Z', '{}')`;
        yield* sql`INSERT INTO orchestration_v2_projection_messages
        (message_id, thread_id, run_id, role, streaming, created_at, updated_at, payload_json)
        VALUES (${change === "unrelated" ? "unrelated-message" : (messages[0] ?? "not-dispatched")}, 'cleanup-thread', 'cleanup-run', 'user', 0,
          '2026-11-01T08:00:00.000Z', '2026-11-01T08:00:00.000Z', '{}')`;
        if (change === "legacy") {
          yield* sql`DELETE FROM scheduled_task_once_runs WHERE task_id = ${task.id}`;
        } else if (change === "early-paused") {
          yield* service.setEnabled({ id: task.id, enabled: false });
        } else if (change === "reschedule") {
          yield* service.upsert({
            ...input,
            id: task.id,
            schedule: { type: "once", runAt: "2026-11-02T08:00:00.000Z" },
          });
        } else if (change === "replace") {
          yield* service.delete({ id: task.id });
          yield* service.upsert({ ...input, id: task.id, enabled: false });
        } else if (change === "interval" || change === "webhook") {
          yield* service.upsert({
            ...input,
            id: task.id,
            enabled: false,
            schedule:
              change === "interval" ? { type: "interval", everyMs: 60000 } : { type: "webhook" },
          });
        }
        if (change === "restart") {
          yield* ScheduledTaskService.ScheduledTaskService.pipe(
            Effect.asVoid,
            Effect.provide(Layer.fresh(serviceLayer)),
          );
        }
        yield* sql`INSERT INTO scheduled_task_webhook_deliveries
          (delivery_id, task_id, received_at, method, query, headers_json, body, body_bytes,
            body_truncated, outcome, signature_verified, missing_fields_json)
          VALUES ('old-webhook-delivery', ${task.id}, '2026-10-01T08:00:00.000Z', 'POST', '', '{}', '', 0, 0, 'accepted', 0, '[]')`;
        const cleanup = sources.get("one-off-cleanup");
        expect(cleanup).toBeDefined();
        yield* cleanup!;
        expect((yield* service.list()).tasks).toHaveLength(removed ? 0 : 1);
        expect(yield* sql`SELECT task_id FROM scheduled_task_once_runs`).toHaveLength(
          change === "replace" || change === "legacy" || removed ? 0 : 1,
        );
        expect(yield* sql`SELECT delivery_id FROM scheduled_task_webhook_deliveries`).toHaveLength(
          removed ? 0 : 1,
        );
        yield* cleanup!;
        expect((yield* service.list()).tasks).toHaveLength(removed ? 0 : 1);
        expect(
          yield* sql`SELECT message_id FROM orchestration_v2_projection_messages`,
        ).toHaveLength(1);
        expect(yield* sql`SELECT run_id FROM orchestration_v2_projection_runs`).toHaveLength(1);
      }).pipe(Effect.provide(serviceLayer));
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
