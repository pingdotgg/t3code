import { assert, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { MigrationsLive } from "../../persistence/Migrations.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { WorkflowBoardSaveLocks } from "../Services/WorkflowBoardSaveLocks.ts";
import { GitHubPort, type GitHubPortShape, type GitHubPrDetail } from "../Services/GitHubPort.ts";
import { WorkflowEnvironmentsReadCapability } from "../Services/WorkflowCapabilities.ts";
import { WorkflowEngine, type WorkflowEngineShape } from "../Services/WorkflowEngine.ts";
import { WorkflowGitHubPoller } from "../Services/WorkflowGitHubPoller.ts";
import { makeWorkflowGitHubPollerLive } from "./WorkflowGitHubPoller.ts";

const unsupported = () => Effect.die("unsupported workflow engine call") as never;

const postedMessages: string[] = [];
const ingestedEvents: Array<{ readonly name: string; readonly ticketId: string }> = [];

const detail = (over: Partial<GitHubPrDetail>): GitHubPrDetail => ({
  number: over.number ?? 1,
  url: over.url ?? "https://github.com/acme/widgets/pull/1",
  state: over.state ?? "open",
  headSha: over.headSha ?? "sha1",
  reviewDecision: over.reviewDecision ?? "none",
  ciState: over.ciState ?? "pending",
});

const GitHubStub = Layer.succeed(GitHubPort, {
  preflight: () => Effect.succeed({ ok: true as const }),
  resolveRemote: () => Effect.succeed({ remoteName: "origin", repo: "acme/widgets" }),
  defaultBranch: () => Effect.succeed("main"),
  openPr: () =>
    Effect.succeed({ number: 1, url: "https://github.com/acme/widgets/pull/1", adopted: false }),
  findPrForBranch: () => Effect.succeed(null),
  prDetail: () => Effect.succeed(detail({ ciState: "failure" })),
  mergePr: () => Effect.succeed({ ok: true as const }),
  failingCheckLogs: () => Effect.succeed("boom: secret=ghp_aaaaaaaaaaaaaaaaaaaaaaaa"),
  listReviewFeedback: () => Effect.succeed([]),
} satisfies GitHubPortShape);

const EngineStub = Layer.succeed(WorkflowEngine, {
  createTicket: () => unsupported(),
  editTicket: () => unsupported(),
  moveTicket: () => unsupported(),
  createTicketAndEnterUnlocked: () => unsupported(),
  closeTicketFromSourceUnlocked: () => unsupported(),
  reopenTicketFromSourceUnlocked: () => unsupported(),
  cancellableProviderTurnsForTicket: () => unsupported(),
  supersedeProviderWorkForTicket: () => unsupported(),
  terminalAgentSessionThreadsForTicket: () => unsupported(),
  stopAgentSessionsForTicket: () => unsupported(),
  editTicketFieldsUnlocked: () => unsupported(),
  withBoardAdmissionLock: (_boardId, effect) => effect,
  runLane: () => unsupported(),
  ingestExternalEvent: (input) =>
    Effect.sync(() => {
      ingestedEvents.push({ name: input.name, ticketId: input.ticketId as string });
      return { outcome: "noop" as const };
    }),
  resolveApproval: () => unsupported(),
  answerTicketStep: () => unsupported(),
  postTicketMessage: (input) =>
    Effect.sync(() => {
      postedMessages.push(input.text ?? "");
    }),
  editTicketMessage: () => unsupported(),
  cancelStep: () => unsupported(),
  cancelBoardPipelines: () => Effect.void,
  cancelTicketPipelines: () => Effect.void,
  recoverBoardWip: () => Effect.void,
  completeRecoveredStep: () => unsupported(),
} satisfies WorkflowEngineShape);

const SaveLocksStub = Layer.succeed(WorkflowBoardSaveLocks, {
  withSaveLock: (_boardId, effect) => effect,
} satisfies WorkflowBoardSaveLocks["Service"]);

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
  makeWorkflowGitHubPollerLive({ sweepIntervalMs: 60_000, maxTicketsPerSweep: 20 }).pipe(
    Layer.provideMerge(GitHubStub),
    Layer.provideMerge(EngineStub),
    Layer.provideMerge(SaveLocksStub),
    Layer.provideMerge(EnvironmentsStub),
    Layer.provideMerge(MigrationsLive),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

layer("WorkflowGitHubPoller", (it) => {
  it.effect("records and applies CI failure observations via the engine", () =>
    Effect.gen(function* () {
      postedMessages.length = 0;
      ingestedEvents.length = 0;
      const poller = yield* WorkflowGitHubPoller;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`
        INSERT INTO p_workflow_boards_projection_board (
          board_id, project_id, name, workflow_file_path, workflow_version_hash, max_concurrent_tickets
        ) VALUES ('board-pr', 'project-1', 'Board', '.t3/board.json', 'hash', 1)
      `;
      yield* sql`
        INSERT INTO p_workflow_boards_projection_ticket (
          ticket_id, board_id, title, current_lane_key, status, created_at, updated_at
        ) VALUES ('ticket-pr', 'board-pr', 'PR ticket', 'review', 'running', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z')
      `;
      yield* sql`
        INSERT INTO p_workflow_boards_pr_state (
          ticket_id, pr_number, pr_url, branch, remote_name, repo,
          pr_state, last_head_sha, last_ci_state, last_review_decision,
          last_comment_cursor, updated_at
        ) VALUES (
          'ticket-pr', 1, 'https://github.com/acme/widgets/pull/1', 'workflow/ticket-pr',
          'origin', 'acme/widgets', 'open', 'sha1', 'pending', NULL, NULL,
          '2026-06-01T00:00:00.000Z'
        )
      `;

      const result = yield* poller.sweep();
      assert.equal(result.observedTickets, 1);
      assert.equal(result.recordedObservations, 1);
      assert.equal(result.appliedObservations, 1);

      const observations = yield* sql<{
        readonly status: string;
        readonly eventName: string;
        readonly messageBody: string | null;
        readonly payloadJson: string;
      }>`
        SELECT
          status,
          event_name AS "eventName",
          message_body AS "messageBody",
          payload_json AS "payloadJson"
        FROM p_workflow_boards_pr_observation
        WHERE ticket_id = 'ticket-pr'
      `;
      assert.equal(observations.length, 1);
      assert.equal(observations[0]?.status, "applied");
      assert.equal(observations[0]?.eventName, "ci.failed");
      assert.equal(observations[0]?.messageBody, null);
      assert.isFalse(observations[0]?.payloadJson.includes("ghp_aaaaaaaa") ?? true);
      assert.equal(postedMessages.length, 1);
      assert.include(postedMessages[0], "[redacted]");
      assert.deepEqual(ingestedEvents, [{ name: "ci.failed", ticketId: "ticket-pr" }]);
    }),
  );
});
