import { assert, it } from "@effect/vitest";
import type { TicketId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { MigrationsLive } from "../../persistence/Migrations.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { MergeGitPort } from "../Services/TicketMergeService.ts";
import { WorkflowWorktreeJanitor } from "../Services/WorkflowWorktreeJanitor.ts";
import { ticketRefsPrefix } from "../ticketRefs.ts";
import { WorkflowWorktreeJanitorLive } from "./WorkflowWorktreeJanitor.ts";

interface RecordedGitCall {
  readonly cwd: string;
  readonly args: ReadonlyArray<string>;
}

const ticketId = "ticket-gc" as TicketId;

const gitCalls: Array<RecordedGitCall> = [];

const stubGit = Layer.succeed(MergeGitPort, {
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

const layer = it.layer(
  WorkflowWorktreeJanitorLive.pipe(
    Layer.provideMerge(stubGit),
    Layer.provideMerge(MigrationsLive),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

layer("WorkflowWorktreeJanitor", (it) => {
  it.effect("removes the worktree, branch, refs and lease row for a ticket", () =>
    Effect.gen(function* () {
      gitCalls.length = 0;
      const janitor = yield* WorkflowWorktreeJanitor;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`
        INSERT INTO worktree_lease (
          worktree_ref, owner_kind, owner_id, fence_token, acquired_at, expires_at
        )
        VALUES (
          ${`workflow/${ticketId}`}, 'step', 'step-run-gc', 1,
          '2026-06-09T00:00:00.000Z', '2026-06-09T01:00:00.000Z'
        )
      `;

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
        SELECT COUNT(*) AS count FROM worktree_lease
        WHERE worktree_ref = ${`workflow/${ticketId}`}
      `;
      assert.equal(leases[0]?.count, 0);
    }),
  );

  it.effect("collects board plans before deletion and tolerates missing rows", () =>
    Effect.gen(function* () {
      const janitor = yield* WorkflowWorktreeJanitor;
      const missing = yield* janitor.collectBoardPlan("board-missing" as never);
      assert.equal(missing, null);

      const missingTicket = yield* janitor.collectTicketPlan("ticket-missing" as never);
      assert.equal(missingTicket, null);

      yield* janitor.run(null);
    }),
  );
});
