import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
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
  it.effect("holds for running provider-native subagents after the parent run completes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* insertThread(sql, { threadId: "thread-1" });
      yield* insertRun(sql, {
        runId: "run-1",
        threadId: "thread-1",
        ordinal: 1,
        status: "completed",
      });
      // App-owned children hold through their own runs, or run on another machine.
      yield* insertSubagent(sql, {
        subagentId: "sub-app",
        threadId: "thread-1",
        origin: "app_owned",
        status: "running",
      });
      expect(yield* KeepAwake.hasActiveWork(sql)).toBe(false);

      yield* insertSubagent(sql, {
        subagentId: "sub-native",
        threadId: "thread-1",
        origin: "provider_native",
        status: "running",
      });
      expect(yield* KeepAwake.hasActiveWork(sql)).toBe(true);

      for (const status of ["waiting", "completed", "interrupted"]) {
        yield* sql`UPDATE orchestration_v2_projection_subagents SET status = ${status} WHERE subagent_id = 'sub-native'`;
        expect(yield* KeepAwake.hasActiveWork(sql)).toBe(false);
      }

      yield* sql`UPDATE orchestration_v2_projection_subagents SET status = 'pending' WHERE subagent_id = 'sub-native'`;
      expect(yield* KeepAwake.hasActiveWork(sql)).toBe(true);

      yield* sql`UPDATE orchestration_v2_projection_threads SET archived_at = ${NOW} WHERE thread_id = 'thread-1'`;
      expect(yield* KeepAwake.hasActiveWork(sql)).toBe(false);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect("holds for awaited background tasks on the active provider thread only", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* insertThread(sql, { threadId: "thread-1", activeProviderThreadId: "pt-active" });
      yield* insertProviderThread(sql, {
        providerThreadId: "pt-active",
        threadId: "thread-1",
        pendingBackgroundTasks: [
          { taskId: "srv-1", kind: "command", description: "Start dev server" },
          { taskId: "mon-1", kind: "monitor", description: "Tail logs" },
        ],
      });
      // An unawaited command or monitor is as often a dev server, which must not block sleep.
      expect(yield* KeepAwake.hasActiveWork(sql)).toBe(false);

      const setTasks = (tasks: ReadonlyArray<Record<string, unknown>>) => sql`
        UPDATE orchestration_v2_projection_provider_threads
        SET payload_json = ${JSON.stringify({ id: "pt-active", pendingBackgroundTasks: tasks })}
        WHERE provider_thread_id = 'pt-active'
      `;
      yield* setTasks([{ taskId: "cmd-1", kind: "command", awaited: true }]);
      expect(yield* KeepAwake.hasActiveWork(sql)).toBe(true);

      yield* setTasks([{ taskId: "agent-1", kind: "subagent" }]);
      expect(yield* KeepAwake.hasActiveWork(sql)).toBe(true);

      yield* sql`UPDATE orchestration_v2_projection_threads SET active_provider_thread_id = 'pt-newer' WHERE thread_id = 'thread-1'`;
      expect(yield* KeepAwake.hasActiveWork(sql)).toBe(false);

      yield* sql`UPDATE orchestration_v2_projection_threads SET active_provider_thread_id = 'pt-active', deleted_at = ${NOW} WHERE thread_id = 'thread-1'`;
      expect(yield* KeepAwake.hasActiveWork(sql)).toBe(false);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );
});
