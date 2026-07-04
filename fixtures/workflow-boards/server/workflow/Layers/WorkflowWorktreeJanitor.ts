import { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type { TicketId } from "../../../contracts/workflow.ts";
import { MergeGitPort } from "../Services/TicketMergeService.ts";
import { WorkflowEnvironmentsReadCapability } from "../Services/WorkflowCapabilities.ts";
import {
  WorkflowWorktreeJanitor,
  type WorkflowWorktreeJanitorShape,
  type WorktreeCleanupPlan,
} from "../Services/WorkflowWorktreeJanitor.ts";
import { ticketRefsPrefix } from "../ticketRefs.ts";

interface ProjectIdRow {
  readonly projectId: string;
}

interface TicketIdRow {
  readonly ticketId: TicketId;
}

const ticketWorktreeRef = (ticketId: TicketId) => `workflow/${ticketId}`;

// Parses `git worktree list --porcelain` into branch-ref -> worktree-path.
const worktreePathsByBranch = (porcelain: string): Map<string, string> => {
  const out = new Map<string, string>();
  let currentPath: string | null = null;
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("worktree ")) {
      currentPath = line.slice("worktree ".length).trim();
    } else if (line.startsWith("branch ") && currentPath !== null) {
      out.set(line.slice("branch ".length).trim(), currentPath);
    } else if (line.trim().length === 0) {
      currentPath = null;
    }
  }
  return out;
};

const make = Effect.gen(function* () {
  const git = yield* MergeGitPort;
  const sql = yield* SqlClient.SqlClient;
  const environments = yield* WorkflowEnvironmentsReadCapability;

  const bestEffort = <A, E>(label: string, effect: Effect.Effect<A, E>) =>
    effect.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("workflow worktree cleanup step failed", { label, cause }),
      ),
      Effect.asVoid,
    );

  const repoRootForProject = (projectId: string) =>
    environments.getProjectById(ProjectId.make(projectId)).pipe(
      Effect.flatMap((project) =>
        project === null
          ? Effect.logWarning("workflow worktree cleanup project missing", { projectId }).pipe(
              Effect.as(null),
            )
          : Effect.succeed(project.workspaceRoot),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("workflow worktree cleanup project lookup failed", {
          projectId,
          cause,
        }).pipe(Effect.as(null)),
      ),
    );

  const collectBoardPlan: WorkflowWorktreeJanitorShape["collectBoardPlan"] = (boardId) =>
    Effect.gen(function* () {
      const projectRows = yield* sql<ProjectIdRow>`
        SELECT project_id AS "projectId"
        FROM p_workflow_boards_projection_board
        WHERE board_id = ${boardId}
        LIMIT 1
      `;
      const projectId = projectRows[0]?.projectId;
      if (projectId === undefined) {
        return null;
      }
      const repoRoot = yield* repoRootForProject(projectId);
      if (repoRoot === null) {
        return null;
      }
      const tickets = yield* sql<TicketIdRow>`
        SELECT ticket_id AS "ticketId"
        FROM p_workflow_boards_projection_ticket
        WHERE board_id = ${boardId}
      `;
      if (tickets.length === 0) {
        return null;
      }
      return { repoRoot, ticketIds: tickets.map((row) => row.ticketId) };
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("workflow worktree cleanup board plan failed", { boardId, cause }).pipe(
          Effect.as(null),
        ),
      ),
    );

  const collectTicketPlan: WorkflowWorktreeJanitorShape["collectTicketPlan"] = (ticketId) =>
    Effect.gen(function* () {
      const projectRows = yield* sql<ProjectIdRow>`
        SELECT board.project_id AS "projectId"
        FROM p_workflow_boards_projection_ticket AS ticket
        INNER JOIN p_workflow_boards_projection_board AS board
          ON board.board_id = ticket.board_id
        WHERE ticket.ticket_id = ${ticketId}
        LIMIT 1
      `;
      const projectId = projectRows[0]?.projectId;
      if (projectId === undefined) {
        return null;
      }
      const repoRoot = yield* repoRootForProject(projectId);
      if (repoRoot === null) {
        return null;
      }
      return { repoRoot, ticketIds: [ticketId] };
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("workflow worktree cleanup ticket plan failed", { ticketId, cause }).pipe(
          Effect.as(null),
        ),
      ),
    );

  const cleanupTicket = (plan: WorktreeCleanupPlan, ticketId: TicketId) =>
    Effect.gen(function* () {
      const worktreeRef = ticketWorktreeRef(ticketId);

      yield* bestEffort(
        "remove worktree",
        Effect.gen(function* () {
          const list = yield* git.run({
            cwd: plan.repoRoot,
            args: ["worktree", "list", "--porcelain"],
          });
          const path = worktreePathsByBranch(list.stdout).get(`refs/heads/${worktreeRef}`);
          if (path !== undefined) {
            yield* git.run({
              cwd: plan.repoRoot,
              args: ["worktree", "remove", "--force", path],
              allowNonZeroExit: true,
            });
          }
          yield* git.run({
            cwd: plan.repoRoot,
            args: ["worktree", "prune"],
            allowNonZeroExit: true,
          });
        }),
      );

      yield* bestEffort(
        "delete ticket branch",
        git.run({
          cwd: plan.repoRoot,
          args: ["branch", "-D", worktreeRef],
          allowNonZeroExit: true,
        }),
      );

      yield* bestEffort(
        "delete ticket checkpoint refs",
        Effect.gen(function* () {
          const refs = yield* git.run({
            cwd: plan.repoRoot,
            args: ["for-each-ref", "--format=%(refname)", `${ticketRefsPrefix(ticketId)}/`],
          });
          for (const ref of refs.stdout.split("\n")) {
            const trimmed = ref.trim();
            if (trimmed.length > 0) {
              yield* git.run({
                cwd: plan.repoRoot,
                args: ["update-ref", "-d", trimmed],
                allowNonZeroExit: true,
              });
            }
          }
        }),
      );

      yield* bestEffort(
        "delete worktree lease row",
        sql`
          DELETE FROM p_workflow_boards_worktree_lease
          WHERE worktree_ref = ${worktreeRef}
        `,
      );
    });

  const run: WorkflowWorktreeJanitorShape["run"] = (plan) =>
    plan === null
      ? Effect.void
      : Effect.forEach(plan.ticketIds, (ticketId) => cleanupTicket(plan, ticketId), {
          discard: true,
        });

  return { collectBoardPlan, collectTicketPlan, run } satisfies WorkflowWorktreeJanitorShape;
});

export const WorkflowWorktreeJanitorLive = Layer.effect(WorkflowWorktreeJanitor, make);
