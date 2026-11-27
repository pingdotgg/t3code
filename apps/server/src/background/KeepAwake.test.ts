import {
  EventId,
  MessageId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as Settings from "../serverSettings.ts";
import * as KeepAwake from "./KeepAwake.ts";

const NOW = "2026-11-27T08:00:00.000Z";

const insertThread = (
  sql: SqlClient.SqlClient,
  input: {
    readonly threadId: string;
    readonly activeProviderThreadId?: string | null;
    readonly archivedAt?: string | null;
    readonly deletedAt?: string | null;
  },
) => sql`
  INSERT INTO orchestration_v2_projection_threads (
    thread_id,
    project_id,
    title,
    default_provider,
    runtime_mode,
    interaction_mode,
    active_provider_thread_id,
    created_at,
    updated_at,
    archived_at,
    deleted_at,
    payload_json
  ) VALUES (
    ${input.threadId},
    'project-1',
    'Test thread',
    'claudeAgent',
    'full-access',
    'default',
    ${input.activeProviderThreadId ?? null},
    ${NOW},
    ${NOW},
    ${input.archivedAt ?? null},
    ${input.deletedAt ?? null},
    ${JSON.stringify({ id: input.threadId })}
  )
`;

const insertRun = (
  sql: SqlClient.SqlClient,
  input: {
    readonly runId: string;
    readonly threadId: string;
    readonly ordinal: number;
    readonly status: string;
  },
) => sql`
  INSERT INTO orchestration_v2_projection_runs (
    run_id,
    thread_id,
    ordinal,
    provider,
    provider_thread_id,
    status,
    requested_at,
    completed_at,
    payload_json
  ) VALUES (
    ${input.runId},
    ${input.threadId},
    ${input.ordinal},
    'claudeAgent',
    NULL,
    ${input.status},
    ${NOW},
    NULL,
    ${JSON.stringify({ id: input.runId, status: input.status })}
  )
`;

const insertSubagent = (
  sql: SqlClient.SqlClient,
  input: {
    readonly subagentId: string;
    readonly threadId: string;
    readonly origin: "provider_native" | "app_owned";
    readonly status: string;
  },
) => sql`
  INSERT INTO orchestration_v2_projection_subagents (
    subagent_id,
    thread_id,
    run_id,
    parent_node_id,
    provider,
    provider_thread_id,
    child_thread_id,
    origin,
    status,
    started_at,
    completed_at,
    updated_at,
    payload_json
  ) VALUES (
    ${input.subagentId},
    ${input.threadId},
    NULL,
    'node-root',
    'claudeAgent',
    NULL,
    NULL,
    ${input.origin},
    ${input.status},
    ${NOW},
    NULL,
    ${NOW},
    ${JSON.stringify({ id: input.subagentId, origin: input.origin, status: input.status })}
  )
`;

const insertProviderThread = (
  sql: SqlClient.SqlClient,
  input: {
    readonly providerThreadId: string;
    readonly threadId: string;
    readonly pendingBackgroundTasks: ReadonlyArray<Record<string, unknown>>;
  },
) => sql`
  INSERT INTO orchestration_v2_projection_provider_threads (
    provider_thread_id,
    thread_id,
    owner_node_id,
    provider,
    provider_session_id,
    status,
    first_run_ordinal,
    last_run_ordinal,
    updated_at,
    payload_json
  ) VALUES (
    ${input.providerThreadId},
    ${input.threadId},
    NULL,
    'claudeAgent',
    NULL,
    'idle',
    1,
    1,
    ${NOW},
    ${JSON.stringify({
      id: input.providerThreadId,
      pendingBackgroundTasks: input.pendingBackgroundTasks,
    })}
  )
`;

describe("KeepAwake.holdWhileWanted", () => {
  it.effect("keeps one hold across a gap shorter than the grace and releases after it", () =>
    Effect.gen(function* () {
      const wanted = yield* Queue.unbounded<boolean>();
      const transitions = yield* Queue.unbounded<"held" | "released">();
      const hold = Effect.acquireRelease(Queue.offer(transitions, "held"), () =>
        Queue.offer(transitions, "released"),
      ).pipe(Effect.andThen(Effect.never), Effect.scoped);
      yield* KeepAwake.holdWhileWanted(Stream.fromQueue(wanted), hold, "60 seconds").pipe(
        Effect.forkScoped,
      );

      yield* Queue.offer(wanted, true);
      expect(yield* Queue.take(transitions)).toBe("held");

      yield* Queue.offer(wanted, false);
      yield* TestClock.adjust("30 seconds");
      yield* Queue.offer(wanted, true);
      yield* TestClock.adjust("120 seconds");
      expect(yield* Queue.size(transitions)).toBe(0);

      yield* Queue.offer(wanted, false);
      yield* TestClock.adjust("120 seconds");
      expect(yield* Queue.take(transitions)).toBe("released");
      expect(yield* Queue.size(transitions)).toBe(0);
    }),
  );
});

describe("KeepAwake.inhibitorCommand", () => {
  it("runs PowerShell by its System32 path on Windows", () => {
    expect(
      KeepAwake.inhibitorCommand("win32", 1, false, { SYSTEMROOT: String.raw`D:\Windows` })
        ?.command,
    ).toBe(String.raw`D:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`);
  });
});

describe("KeepAwake.hasActiveWork", () => {
  it.effect("counts active runs and ignores waiting or completed runs", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* insertThread(sql, { threadId: "thread-1" });

      expect(yield* KeepAwake.hasActiveWork(sql)).toBe(false);

      yield* insertRun(sql, {
        runId: "run-1",
        threadId: "thread-1",
        ordinal: 1,
        status: "waiting",
      });
      expect(yield* KeepAwake.hasActiveWork(sql)).toBe(false);

      yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'running' WHERE run_id = 'run-1'`;
      expect(yield* KeepAwake.hasActiveWork(sql)).toBe(true);

      yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'completed' WHERE run_id = 'run-1'`;
      expect(yield* KeepAwake.hasActiveWork(sql)).toBe(false);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect("holds for active provider-native subagents after the parent run completes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* insertThread(sql, { threadId: "thread-1" });
      yield* insertRun(sql, {
        runId: "run-1",
        threadId: "thread-1",
        ordinal: 1,
        status: "completed",
      });
      yield* insertSubagent(sql, {
        subagentId: "sub-native",
        threadId: "thread-1",
        origin: "provider_native",
        status: "running",
      });

      expect(yield* KeepAwake.hasActiveWork(sql)).toBe(true);

      // Waiting on the user or terminal subagent statuses should not hold the inhibitor.
      for (const status of ["waiting", "completed", "failed", "cancelled", "interrupted"]) {
        yield* sql`UPDATE orchestration_v2_projection_subagents SET status = ${status} WHERE subagent_id = 'sub-native'`;
        expect(yield* KeepAwake.hasActiveWork(sql)).toBe(false);
      }

      // Pending provider-native subagent still holds until archived/deleted.
      yield* sql`UPDATE orchestration_v2_projection_subagents SET status = 'pending' WHERE subagent_id = 'sub-native'`;
      expect(yield* KeepAwake.hasActiveWork(sql)).toBe(true);

      yield* sql`UPDATE orchestration_v2_projection_threads SET archived_at = ${NOW} WHERE thread_id = 'thread-1'`;
      expect(yield* KeepAwake.hasActiveWork(sql)).toBe(false);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect("does not hold for app-owned subagents on their own", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* insertThread(sql, { threadId: "thread-1" });
      yield* insertSubagent(sql, {
        subagentId: "sub-app",
        threadId: "thread-1",
        origin: "app_owned",
        status: "running",
      });

      // Local app-owned child threads hold via their own run rows; remote children run elsewhere.
      expect(yield* KeepAwake.hasActiveWork(sql)).toBe(false);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect("holds for awaited provider background tasks and ignores unawaited daemons", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* insertThread(sql, {
        threadId: "thread-1",
        activeProviderThreadId: "pt-active",
      });
      yield* insertProviderThread(sql, {
        providerThreadId: "pt-active",
        threadId: "thread-1",
        pendingBackgroundTasks: [
          { taskId: "srv-1", kind: "command", description: "Start dev server in background" },
          { taskId: "mon-1", kind: "monitor", description: "Tail logs" },
        ],
      });

      // Unawaited background commands and monitors (e.g. dev servers) must not block sleep.
      expect(yield* KeepAwake.hasActiveWork(sql)).toBe(false);

      // Awaited background command holds.
      yield* sql`
        UPDATE orchestration_v2_projection_provider_threads
        SET payload_json = ${JSON.stringify({
          id: "pt-active",
          pendingBackgroundTasks: [
            { taskId: "cmd-1", kind: "command", description: "pnpm test", awaited: true },
          ],
        })}
        WHERE provider_thread_id = 'pt-active'
      `;
      expect(yield* KeepAwake.hasActiveWork(sql)).toBe(true);

      // Background subagent or generic background_task holds.
      yield* sql`
        UPDATE orchestration_v2_projection_provider_threads
        SET payload_json = ${JSON.stringify({
          id: "pt-active",
          pendingBackgroundTasks: [{ taskId: "agent-1", kind: "subagent", description: "QA pass" }],
        })}
        WHERE provider_thread_id = 'pt-active'
      `;
      expect(yield* KeepAwake.hasActiveWork(sql)).toBe(true);

      // Stale roster on a non-active provider thread does not hold.
      yield* sql`
        UPDATE orchestration_v2_projection_threads
        SET active_provider_thread_id = 'pt-newer'
        WHERE thread_id = 'thread-1'
      `;
      expect(yield* KeepAwake.hasActiveWork(sql)).toBe(false);

      // Deleted thread does not hold even when active_provider_thread_id matches.
      yield* sql`
        UPDATE orchestration_v2_projection_threads
        SET active_provider_thread_id = 'pt-active', deleted_at = ${NOW}
        WHERE thread_id = 'thread-1'
      `;
      expect(yield* KeepAwake.hasActiveWork(sql)).toBe(false);

      // Verify the provider-thread pending tasks scan uses the existing partial index.
      const plan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT pt.payload_json
        FROM orchestration_v2_projection_provider_threads AS pt
        JOIN orchestration_v2_projection_threads AS thread
          ON thread.thread_id = pt.thread_id
        WHERE CASE WHEN json_valid(pt.payload_json)
            THEN json_array_length(pt.payload_json, '$.pendingBackgroundTasks') > 0
            ELSE 0 END
          AND thread.deleted_at IS NULL
          AND thread.archived_at IS NULL
          AND (
            thread.active_provider_thread_id IS NULL
            OR thread.active_provider_thread_id = pt.provider_thread_id
          )
      `;
      expect(
        plan.some((row) =>
          row.detail.includes("orchestration_v2_projection_provider_threads_pending_tasks_idx"),
        ),
      ).toBe(true);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );
});

describe("KeepAwake.layer", () => {
  it.effect(
    "keeps the inhibitor held after a run finishes while a native subagent or awaited task works",
    () =>
      Effect.gen(function* () {
        const transitions = yield* Queue.unbounded<"held" | "released">();
        const sql = yield* SqlClient.SqlClient;
        const eventStore = yield* OrchestrationEventStore.OrchestrationEventStore;

        const spawner = ChildProcessSpawner.make(() =>
          Effect.gen(function* () {
            const released = yield* Deferred.make<void>();
            yield* Queue.offer(transitions, "held");
            yield* Effect.addFinalizer(() =>
              Deferred.succeed(released, undefined).pipe(
                Effect.andThen(Queue.offer(transitions, "released")),
              ),
            );
            return ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(42),
              exitCode: Deferred.await(released).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
              isRunning: Effect.succeed(true),
              kill: () => Deferred.succeed(released, undefined).pipe(Effect.asVoid),
              unref: Effect.succeed(Effect.void),
              stdin: Sink.drain,
              stdout: Stream.make(new TextEncoder().encode("\n")),
              stderr: Stream.empty,
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
            });
          }),
        );

        const now = DateTime.makeUnsafe(NOW);
        const threadId = ThreadId.make("thread-1");
        const runId = RunId.make("run-1");
        const providerThreadId = ProviderThreadId.make("pt-1");
        const driver = ProviderDriverKind.make("claudeAgent");
        const providerInstanceId = ProviderInstanceId.make("claudeAgent");
        const subagentId = NodeId.make("sub-1");
        const parentNodeId = NodeId.make("node-root");

        // 1. Start with an active parent run so initial KeepAwake hydration acquires the inhibitor
        // and guarantees the live event stream is subscribed before we publish follow-up events.
        yield* insertThread(sql, {
          threadId,
          activeProviderThreadId: providerThreadId,
        });
        yield* insertRun(sql, { runId, threadId, ordinal: 1, status: "running" });

        yield* Layer.build(KeepAwake.layer).pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(HostProcess.Platform, "win32"),
              Layer.succeed(HostProcess.Environment, { SYSTEMROOT: String.raw`C:\Windows` }),
              FileSystem.layerNoop({}),
              Settings.ServerSettingsService.layerTest(),
              Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
            ),
          ),
        );
        expect(yield* Queue.take(transitions)).toBe("held");

        let sequence = 0;
        const publish = (event: OrchestrationV2DomainEvent) =>
          eventStore.publishCommitted([
            {
              sequence: ++sequence,
              commandId: null,
              event,
            },
          ]);
        const settleStream = Effect.forEach(Array.from({ length: 10 }), () => Effect.yieldNow);

        // 2. Native background subagent starts and parent run completes -> inhibitor stays held past grace.
        yield* insertSubagent(sql, {
          subagentId,
          threadId,
          origin: "provider_native",
          status: "running",
        });
        yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'completed' WHERE run_id = ${runId}`;
        yield* publish({
          id: EventId.make("evt-2"),
          type: "subagent.updated",
          threadId,
          runId,
          nodeId: subagentId,
          driver,
          providerInstanceId,
          occurredAt: now,
          payload: {
            id: subagentId,
            threadId,
            runId,
            parentNodeId,
            origin: "provider_native",
            createdBy: "agent",
            driver,
            providerInstanceId,
            providerThreadId: null,
            childThreadId: null,
            nativeTaskRef: null,
            prompt: "Run QA",
            title: "QA",
            model: null,
            status: "running",
            result: null,
            startedAt: now,
            completedAt: null,
            updatedAt: now,
          },
        });
        yield* publish({
          id: EventId.make("evt-3"),
          type: "run.updated",
          threadId,
          runId,
          driver,
          providerInstanceId,
          occurredAt: now,
          payload: {
            id: runId,
            threadId,
            ordinal: 1,
            providerInstanceId,
            modelSelection: { instanceId: providerInstanceId, model: "claude-sonnet-4-6" },
            providerThreadId,
            userMessageId: MessageId.make("msg-1"),
            rootNodeId: parentNodeId,
            activeAttemptId: null,
            status: "completed",
            requestedAt: now,
            startedAt: now,
            completedAt: now,
            checkpointId: null,
            contextHandoffId: null,
          },
        });
        yield* settleStream;
        yield* TestClock.adjust("120 seconds");
        expect(yield* Queue.size(transitions)).toBe(0);

        // 3. Background subagent finishes -> inhibitor releases after the 60s grace period.
        yield* sql`UPDATE orchestration_v2_projection_subagents SET status = 'completed' WHERE subagent_id = ${subagentId}`;
        yield* publish({
          id: EventId.make("evt-4"),
          type: "subagent.updated",
          threadId,
          runId,
          nodeId: subagentId,
          driver,
          providerInstanceId,
          occurredAt: now,
          payload: {
            id: subagentId,
            threadId,
            runId,
            parentNodeId,
            origin: "provider_native",
            createdBy: "agent",
            driver,
            providerInstanceId,
            providerThreadId: null,
            childThreadId: null,
            nativeTaskRef: null,
            prompt: "Run QA",
            title: "QA",
            model: null,
            status: "completed",
            result: "Done",
            startedAt: now,
            completedAt: now,
            updatedAt: now,
          },
        });
        yield* settleStream;
        yield* TestClock.adjust("65 seconds");
        expect(yield* Queue.take(transitions)).toBe("released");

        // 4. Provider thread reports an awaited background task -> holds, then releases when cleared.
        yield* insertProviderThread(sql, {
          providerThreadId,
          threadId,
          pendingBackgroundTasks: [
            { taskId: "cmd-1", kind: "command", description: "pnpm test", awaited: true },
          ],
        });
        yield* publish({
          id: EventId.make("evt-5"),
          type: "provider-thread.updated",
          threadId,
          driver,
          providerInstanceId,
          occurredAt: now,
          payload: {
            id: providerThreadId,
            driver,
            providerInstanceId,
            providerSessionId: null,
            appThreadId: threadId,
            ownerNodeId: null,
            nativeThreadRef: null,
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: 1,
            lastRunOrdinal: 1,
            handoffIds: [],
            forkedFrom: null,
            pendingBackgroundTasks: [
              { taskId: "cmd-1", kind: "command", description: "pnpm test", awaited: true },
            ],
            contextUsage: null,
            nativeMetadata: null,
            goal: null,
            createdAt: now,
            updatedAt: now,
          },
        });
        expect(yield* Queue.take(transitions)).toBe("held");

        yield* sql`
          UPDATE orchestration_v2_projection_provider_threads
          SET payload_json = ${JSON.stringify({ id: providerThreadId, pendingBackgroundTasks: [] })}
          WHERE provider_thread_id = ${providerThreadId}
        `;
        yield* publish({
          id: EventId.make("evt-6"),
          type: "provider-thread.updated",
          threadId,
          driver,
          providerInstanceId,
          occurredAt: now,
          payload: {
            id: providerThreadId,
            driver,
            providerInstanceId,
            providerSessionId: null,
            appThreadId: threadId,
            ownerNodeId: null,
            nativeThreadRef: null,
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: 1,
            lastRunOrdinal: 1,
            handoffIds: [],
            forkedFrom: null,
            pendingBackgroundTasks: [],
            contextUsage: null,
            nativeMetadata: null,
            goal: null,
            createdAt: now,
            updatedAt: now,
          },
        });
        yield* settleStream;
        yield* TestClock.adjust("65 seconds");
        expect(yield* Queue.take(transitions)).toBe("released");
      }).pipe(
        Effect.provide(
          OrchestrationEventStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
        ),
      ),
  );
});
