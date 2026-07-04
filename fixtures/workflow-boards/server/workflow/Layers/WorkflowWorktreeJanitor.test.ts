import { assert, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type { TicketId } from "../../../contracts/workflow.ts";
import { MigrationsLive } from "../../persistence/Migrations.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { MergeGitPort } from "../Services/TicketMergeService.ts";
import { WorkflowEnvironmentsReadCapability } from "../Services/WorkflowCapabilities.ts";
import { WorkflowWorktreeJanitor } from "../Services/WorkflowWorktreeJanitor.ts";
import { ticketRefsPrefix } from "../ticketRefs.ts";
import { WorkflowWorktreeJanitorLive } from "./WorkflowWorktreeJanitor.ts";

interface RecordedGitCall {
  readonly cwd: string;
  readonly args: ReadonlyArray<string>;
}

const ticketId = "ticket-gc" as TicketId;
const gitCalls: Array<RecordedGitCall> = [];

const GitStub = Layer.succeed(MergeGitPort, {
  run: (input) =>
    Effect.sync(() => {
      gitCalls.push({ cwd: input.cwd, args: input.args });
      if (input.args[0] === "worktree" && input.args[1] === "list") {
        return {
          exitCode: 0,
          stdout: [
            "worktree /repo",
            "branch refs/heads/main",
            "",
            "worktree /repo-worktrees/ticket-gc",
            `branch refs/heads/workflow/${ticketId}`,
            "",
          ].join("\n"),
          stderr: "",
        };
      }
      if (input.args[0] === "for-each-ref") {
        return {
          exitCode: 0,
          stdout: `${ticketRefsPrefix(ticketId)}/base\n${ticketRefsPrefix(ticketId)}/step/abc/pre\n`,
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    }),
});

const EnvironmentsStub = Layer.succeed(WorkflowEnvironmentsReadCapability, {
  getEnvironmentId: Effect.die("unused getEnvironmentId"),
  getDescriptor: Effect.die("unused getDescriptor"),
  listProjects: Effect.die("unused listProjects"),
  getProjectById: (projectId) =>
    Effect.succeed(
      projectId === ProjectId.make("project-1")
        ? {
            id: ProjectId.make("project-1"),
            title: "Project",
            workspaceRoot: "/repo",
            defaultModelSelection: null,
            scripts: [],
            createdAt: "2026-06-01T00:00:00.000Z",
            updatedAt: "2026-06-01T00:00:00.000Z",
          }
        : null,
    ),
  resolveProjectByWorkspaceRoot: () => Effect.die("unused resolveProjectByWorkspaceRoot"),
} satisfies WorkflowEnvironmentsReadCapability["Service"]);

const layer = it.layer(
  WorkflowWorktreeJanitorLive.pipe(
    Layer.provideMerge(GitStub),
    Layer.provideMerge(EnvironmentsStub),
    Layer.provideMerge(MigrationsLive),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

layer("WorkflowWorktreeJanitor", (it) => {
  it.effect("collects plans through environments and removes worktree residue", () =>
    Effect.gen(function* () {
      gitCalls.length = 0;
      const janitor = yield* WorkflowWorktreeJanitor;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`
        INSERT INTO p_workflow_boards_projection_board (
          board_id, project_id, name, workflow_file_path, workflow_version_hash, max_concurrent_tickets
        ) VALUES ('board-gc', 'project-1', 'Board', '.t3/board.json', 'hash', 1)
      `;
      yield* sql`
        INSERT INTO p_workflow_boards_projection_ticket (
          ticket_id, board_id, title, current_lane_key, status, created_at, updated_at
        ) VALUES (${ticketId}, 'board-gc', 'Ticket', 'todo', 'running', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z')
      `;
      yield* sql`
        INSERT INTO p_workflow_boards_worktree_lease (
          worktree_ref, owner_kind, owner_id, fence_token, acquired_at, expires_at
        ) VALUES (
          ${`workflow/${ticketId}`}, 'step', 'step-run-gc', 1,
          '2026-06-09T00:00:00.000Z', '2026-06-09T01:00:00.000Z'
        )
      `;

      assert.deepEqual(yield* janitor.collectBoardPlan("board-gc" as never), {
        repoRoot: "/repo",
        ticketIds: [ticketId],
      });
      assert.deepEqual(yield* janitor.collectTicketPlan(ticketId), {
        repoRoot: "/repo",
        ticketIds: [ticketId],
      });

      yield* janitor.run({ repoRoot: "/repo", ticketIds: [ticketId] });

      assert.ok(
        gitCalls.some(
          (call) =>
            call.args[0] === "worktree" &&
            call.args[1] === "remove" &&
            call.args.includes("/repo-worktrees/ticket-gc"),
        ),
      );
      assert.ok(gitCalls.some((call) => call.args[0] === "branch" && call.args[1] === "-D"));
      assert.equal(
        gitCalls.filter((call) => call.args[0] === "update-ref" && call.args[1] === "-d").length,
        2,
      );

      const leases = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM p_workflow_boards_worktree_lease
        WHERE worktree_ref = ${`workflow/${ticketId}`}
      `;
      assert.equal(leases[0]?.count, 0);
    }),
  );
});
