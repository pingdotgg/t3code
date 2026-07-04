import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { MigrationsLive } from "../../persistence/Migrations.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { WorkflowAgentsCapability } from "../Services/WorkflowAgentPort.ts";
import { WorkflowThreadJanitor } from "../Services/WorkflowThreadJanitor.ts";
import { WorkflowThreadJanitorLive } from "./WorkflowThreadJanitor.ts";

const deletedThreads: string[] = [];

const AgentsStub = Layer.succeed(WorkflowAgentsCapability, {
  listInstances: () => Effect.succeed({ available: [], unavailable: [] }),
  createThread: () => Effect.die("unused createThread"),
  startTurn: () => Effect.die("unused startTurn"),
  observeThread: () => Stream.empty,
  awaitTurn: () => Effect.die("unused awaitTurn"),
  listPendingRequests: () => Effect.succeed([]),
  respondToApproval: () => Effect.die("unused respondToApproval"),
  respondToUserInput: () => Effect.die("unused respondToUserInput"),
  interruptTurn: () => Effect.die("unused interruptTurn"),
  stopSession: () => Effect.void,
  deleteThread: ({ threadId }) =>
    Effect.sync(() => {
      deletedThreads.push(threadId);
    }),
} satisfies WorkflowAgentsCapability["Service"]);

const layer = it.layer(
  WorkflowThreadJanitorLive.pipe(
    Layer.provideMerge(AgentsStub),
    Layer.provideMerge(MigrationsLive),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

layer("WorkflowThreadJanitor", (it) => {
  it.effect("collects dispatch threads and deletes them through the agents capability", () =>
    Effect.gen(function* () {
      deletedThreads.length = 0;
      const janitor = yield* WorkflowThreadJanitor;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`
        INSERT INTO p_workflow_boards_projection_board (
          board_id, project_id, name, workflow_file_path, workflow_version_hash, max_concurrent_tickets
        ) VALUES ('board-threads', 'project-1', 'Board', '.t3/board.json', 'hash', 1)
      `;
      yield* sql`
        INSERT INTO p_workflow_boards_projection_ticket (
          ticket_id, board_id, title, current_lane_key, status, created_at, updated_at
        ) VALUES
          ('ticket-a', 'board-threads', 'A', 'todo', 'running', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z'),
          ('ticket-b', 'board-threads', 'B', 'todo', 'running', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z')
      `;
      yield* sql`
        INSERT INTO p_workflow_boards_dispatch_outbox (
          dispatch_id, ticket_id, step_run_id, thread_id, provider_instance, model, instruction,
          worktree_path, status, created_at
        ) VALUES
          ('dispatch-a', 'ticket-a', 'step-a', 'thread-a', 'codex', 'gpt-5.5', 'run', '/tmp/a', 'terminal', '2026-06-01T00:00:00.000Z'),
          ('dispatch-b', 'ticket-b', 'step-b', 'thread-b', 'codex', 'gpt-5.5', 'run', '/tmp/b', 'terminal', '2026-06-01T00:00:00.000Z'),
          ('dispatch-b2', 'ticket-b', 'step-b2', 'thread-b', 'codex', 'gpt-5.5', 'run', '/tmp/b', 'terminal', '2026-06-01T00:00:00.000Z')
      `;

      assert.sameMembers(
        [...(yield* janitor.collectBoardThreads("board-threads" as never))],
        ["thread-a", "thread-b"],
      );
      assert.deepEqual(yield* janitor.collectTicketThreads("ticket-a" as never), ["thread-a"]);

      yield* janitor.deleteThreads(["thread-a", "thread-b"]);
      assert.deepEqual(deletedThreads, [ThreadId.make("thread-a"), ThreadId.make("thread-b")]);
    }),
  );
});
