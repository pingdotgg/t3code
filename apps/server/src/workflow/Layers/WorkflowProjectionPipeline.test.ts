import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { MigrationsLive } from "../../persistence/Migrations.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { BoardRegistry } from "../Services/BoardRegistry.ts";
import { WorkflowProjectionPipeline } from "../Services/WorkflowProjectionPipeline.ts";
import { BoardRegistryLive } from "./BoardRegistry.ts";
import { WorkflowProjectionPipelineLive } from "./WorkflowProjectionPipeline.ts";

const layer = it.layer(
  WorkflowProjectionPipelineLive.pipe(
    Layer.provideMerge(BoardRegistryLive),
    Layer.provideMerge(MigrationsLive),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

layer("WorkflowProjectionPipeline", (it) => {
  it.effect("projects TicketCreated then TicketMovedToLane into projection_ticket", () =>
    Effect.gen(function* () {
      const pipeline = yield* WorkflowProjectionPipeline;
      const sql = yield* SqlClient.SqlClient;

      yield* pipeline.projectEvent({
        type: "TicketCreated",
        eventId: "e1" as never,
        ticketId: "t-1" as never,
        streamVersion: 0,
        occurredAt: "2026-06-07T00:00:00.000Z" as never,
        payload: {
          boardId: "b-1" as never,
          title: "Export CSV" as never,
          laneKey: "backlog" as never,
        },
      });
      yield* pipeline.projectEvent({
        type: "TicketMovedToLane",
        eventId: "e2" as never,
        ticketId: "t-1" as never,
        streamVersion: 1,
        occurredAt: "2026-06-07T00:00:01.000Z" as never,
        payload: {
          toLane: "implement" as never,
          laneEntryToken: "tok-1" as never,
          reason: "routed",
        },
      });

      const rows = yield* sql<{
        readonly currentLaneEntryToken: string | null;
        readonly currentLaneKey: string;
        readonly status: string;
      }>`
        SELECT
          current_lane_entry_token AS "currentLaneEntryToken",
          current_lane_key AS "currentLaneKey",
          status
        FROM projection_ticket
        WHERE ticket_id = 't-1'
      `;
      assert.equal(rows[0]?.currentLaneEntryToken, "tok-1");
      assert.equal(rows[0]?.currentLaneKey, "implement");
      assert.equal(rows[0]?.status, "idle");
    }),
  );

  it.effect("projects ticket descriptions, edits, and ticket messages", () =>
    Effect.gen(function* () {
      const pipeline = yield* WorkflowProjectionPipeline;
      const sql = yield* SqlClient.SqlClient;

      yield* pipeline.projectEvent({
        type: "TicketCreated",
        eventId: "ticket-collab-a" as never,
        ticketId: "ticket-collab" as never,
        streamVersion: 0,
        occurredAt: "2026-06-08T00:00:00.000Z" as never,
        payload: {
          boardId: "board-collab" as never,
          title: "Original title" as never,
          description: "Original description",
          laneKey: "backlog" as never,
        },
      });
      yield* pipeline.projectEvent({
        type: "TicketEdited",
        eventId: "ticket-collab-b" as never,
        ticketId: "ticket-collab" as never,
        streamVersion: 1,
        occurredAt: "2026-06-08T00:00:01.000Z" as never,
        payload: {
          title: "Updated title" as never,
          description: "",
        },
      });
      yield* pipeline.projectEvent({
        type: "TicketMessagePosted",
        eventId: "ticket-collab-c" as never,
        ticketId: "ticket-collab" as never,
        streamVersion: 2,
        occurredAt: "2026-06-08T00:00:02.000Z" as never,
        payload: {
          messageId: "message-collab" as never,
          stepRunId: "step-collab" as never,
          author: "user",
          body: "Use the sandbox endpoint.",
          attachments: [
            {
              kind: "image",
              id: "image-collab",
              name: "screenshot.png",
              mimeType: "image/png",
              sizeBytes: 1200,
              dataUrl: "data:image/png;base64,AAAA",
            },
          ],
          createdAt: "2026-06-08T00:00:02.000Z" as never,
        },
      });

      const tickets = yield* sql<{
        readonly title: string;
        readonly description: string | null;
      }>`
        SELECT title, description
        FROM projection_ticket
        WHERE ticket_id = 'ticket-collab'
      `;
      const messages = yield* sql<{
        readonly messageId: string;
        readonly stepRunId: string | null;
        readonly author: string;
        readonly body: string;
        readonly attachmentsJson: string;
      }>`
        SELECT
          message_id AS "messageId",
          step_run_id AS "stepRunId",
          author,
          body,
          attachments_json AS "attachmentsJson"
        FROM projection_ticket_message
        WHERE ticket_id = 'ticket-collab'
      `;

      assert.equal(tickets[0]?.title, "Updated title");
      assert.equal(tickets[0]?.description, "");
      assert.equal(messages[0]?.messageId, "message-collab");
      assert.equal(messages[0]?.stepRunId, "step-collab");
      assert.equal(messages[0]?.author, "user");
      assert.equal(messages[0]?.body, "Use the sandbox endpoint.");
      assert.include(messages[0]?.attachmentsJson ?? "", "data:image/png;base64,AAAA");
    }),
  );

  it.effect("projects TicketMessageEdited, updating body and edited_at (idempotent re-apply)", () =>
    Effect.gen(function* () {
      const pipeline = yield* WorkflowProjectionPipeline;
      const sql = yield* SqlClient.SqlClient;

      yield* pipeline.projectEvent({
        type: "TicketCreated",
        eventId: "ticket-edit-a" as never,
        ticketId: "ticket-edit" as never,
        streamVersion: 0,
        occurredAt: "2026-06-17T00:00:00.000Z" as never,
        payload: {
          boardId: "board-edit" as never,
          title: "Edit message ticket" as never,
          laneKey: "backlog" as never,
        },
      });
      yield* pipeline.projectEvent({
        type: "TicketMessagePosted",
        eventId: "ticket-edit-b" as never,
        ticketId: "ticket-edit" as never,
        streamVersion: 1,
        occurredAt: "2026-06-17T00:00:01.000Z" as never,
        payload: {
          messageId: "message-edit" as never,
          author: "user",
          body: "Original body.",
          attachments: [],
          createdAt: "2026-06-17T00:00:01.000Z" as never,
        },
      });

      const beforeEdit = yield* sql<{
        readonly body: string;
        readonly editedAt: string | null;
      }>`
        SELECT body, edited_at AS "editedAt"
        FROM projection_ticket_message
        WHERE message_id = 'message-edit'
      `;
      assert.equal(beforeEdit[0]?.body, "Original body.");
      assert.equal(beforeEdit[0]?.editedAt, null);

      const editEvent = {
        type: "TicketMessageEdited" as const,
        eventId: "ticket-edit-c" as never,
        ticketId: "ticket-edit" as never,
        streamVersion: 2,
        occurredAt: "2026-06-17T00:00:02.000Z" as never,
        payload: {
          messageId: "message-edit" as never,
          body: "Edited body.",
          editedAt: "2026-06-17T00:00:02.000Z" as never,
        },
      };
      yield* pipeline.projectEvent(editEvent);

      const afterEdit = yield* sql<{
        readonly body: string;
        readonly editedAt: string | null;
      }>`
        SELECT body, edited_at AS "editedAt"
        FROM projection_ticket_message
        WHERE message_id = 'message-edit'
      `;
      assert.equal(afterEdit[0]?.body, "Edited body.");
      assert.equal(afterEdit[0]?.editedAt, "2026-06-17T00:00:02.000Z");

      // Re-apply the same edit event — must be idempotent (no duplicate rows, same values).
      yield* pipeline.projectEvent(editEvent);

      const afterReapply = yield* sql<{
        readonly body: string;
        readonly editedAt: string | null;
      }>`
        SELECT body, edited_at AS "editedAt"
        FROM projection_ticket_message
        WHERE message_id = 'message-edit'
      `;
      assert.equal(afterReapply.length, 1);
      assert.equal(afterReapply[0]?.body, "Edited body.");
      assert.equal(afterReapply[0]?.editedAt, "2026-06-17T00:00:02.000Z");
    }),
  );

  it.effect("records terminal_at when a ticket enters a terminal lane without later bumps", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      const pipeline = yield* WorkflowProjectionPipeline;
      const sql = yield* SqlClient.SqlClient;

      yield* registry.register("board-terminal-clock" as never, {
        name: "terminal clock",
        lanes: [
          { key: "backlog", name: "Backlog", entry: "manual" },
          { key: "done", name: "Done", entry: "manual", terminal: true },
        ],
      });
      yield* pipeline.projectEvent({
        type: "TicketCreated",
        eventId: "terminal-clock-a" as never,
        ticketId: "ticket-terminal-clock" as never,
        streamVersion: 0,
        occurredAt: "2026-06-08T00:00:00.000Z" as never,
        payload: {
          boardId: "board-terminal-clock" as never,
          title: "Ship cleanup" as never,
          laneKey: "backlog" as never,
        },
      });
      yield* pipeline.projectEvent({
        type: "TicketMovedToLane",
        eventId: "terminal-clock-b" as never,
        ticketId: "ticket-terminal-clock" as never,
        streamVersion: 1,
        occurredAt: "2026-06-08T00:00:01.000Z" as never,
        payload: {
          toLane: "done" as never,
          laneEntryToken: "tok-terminal-clock" as never,
          reason: "manual",
        },
      });
      yield* pipeline.projectEvent({
        type: "TicketEdited",
        eventId: "terminal-clock-c" as never,
        ticketId: "ticket-terminal-clock" as never,
        streamVersion: 2,
        occurredAt: "2026-06-08T00:00:02.000Z" as never,
        payload: { title: "Ship cleanup after comment" as never },
      });
      yield* pipeline.projectEvent({
        type: "TicketMessagePosted",
        eventId: "terminal-clock-d" as never,
        ticketId: "ticket-terminal-clock" as never,
        streamVersion: 3,
        occurredAt: "2026-06-08T00:00:03.000Z" as never,
        payload: {
          messageId: "message-terminal-clock" as never,
          author: "user",
          body: "Post-terminal note.",
          attachments: [],
          createdAt: "2026-06-08T00:00:03.000Z" as never,
        },
      });

      const rows = yield* sql<{
        readonly terminalAt: string | null;
        readonly updatedAt: string;
      }>`
        SELECT
          terminal_at AS "terminalAt",
          updated_at AS "updatedAt"
        FROM projection_ticket
        WHERE ticket_id = 'ticket-terminal-clock'
      `;

      assert.equal(rows[0]?.terminalAt, "2026-06-08T00:00:01.000Z");
      assert.equal(rows[0]?.updatedAt, "2026-06-08T00:00:02.000Z");
    }),
  );

  it.effect("projects queued and admitted ticket lane-entry state", () =>
    Effect.gen(function* () {
      const pipeline = yield* WorkflowProjectionPipeline;
      const sql = yield* SqlClient.SqlClient;
      const base = {
        ticketId: "t-queue" as never,
        occurredAt: "2026-06-07T00:00:00.000Z" as never,
      };

      yield* pipeline.projectEvent({
        ...base,
        type: "TicketCreated",
        eventId: "queue-a" as never,
        streamVersion: 0,
        payload: {
          boardId: "b-queue" as never,
          title: "Queued ticket" as never,
          laneKey: "backlog" as never,
        },
      });
      yield* pipeline.projectEvent({
        ...base,
        type: "TicketQueued",
        eventId: "queue-b" as never,
        streamVersion: 1,
        occurredAt: "2026-06-07T00:00:01.000Z" as never,
        payload: { lane: "implement" as never },
      } as never);

      const queued = yield* sql<{
        readonly currentLaneEntryToken: string | null;
        readonly currentLaneKey: string;
        readonly queuedAt: string | null;
        readonly status: string;
      }>`
        SELECT
          current_lane_entry_token AS "currentLaneEntryToken",
          current_lane_key AS "currentLaneKey",
          queued_at AS "queuedAt",
          status
        FROM projection_ticket
        WHERE ticket_id = 't-queue'
      `;
      assert.equal(queued[0]?.currentLaneEntryToken, null);
      assert.equal(queued[0]?.currentLaneKey, "implement");
      assert.equal(queued[0]?.queuedAt, "2026-06-07T00:00:01.000Z");
      assert.equal(queued[0]?.status, "queued");

      yield* pipeline.projectEvent({
        ...base,
        type: "TicketAdmitted",
        eventId: "queue-c" as never,
        streamVersion: 2,
        occurredAt: "2026-06-07T00:00:02.000Z" as never,
        payload: {
          lane: "implement" as never,
          laneEntryToken: "tok-admitted" as never,
        },
      } as never);

      const admitted = yield* sql<{
        readonly currentLaneEntryToken: string | null;
        readonly queuedAt: string | null;
        readonly status: string;
      }>`
        SELECT
          current_lane_entry_token AS "currentLaneEntryToken",
          queued_at AS "queuedAt",
          status
        FROM projection_ticket
        WHERE ticket_id = 't-queue'
      `;
      assert.equal(admitted[0]?.currentLaneEntryToken, "tok-admitted");
      assert.equal(admitted[0]?.queuedAt, null);
      assert.equal(admitted[0]?.status, "idle");

      yield* pipeline.projectEvent({
        ...base,
        type: "TicketQueued",
        eventId: "queue-d" as never,
        streamVersion: 3,
        occurredAt: "2026-06-07T00:00:03.000Z" as never,
        payload: { lane: "review" as never },
      } as never);
      yield* pipeline.projectEvent({
        ...base,
        type: "TicketMovedToLane",
        eventId: "queue-e" as never,
        streamVersion: 4,
        occurredAt: "2026-06-07T00:00:04.000Z" as never,
        payload: {
          toLane: "done" as never,
          laneEntryToken: "tok-moved" as never,
          reason: "manual",
        },
      });

      const moved = yield* sql<{
        readonly currentLaneEntryToken: string | null;
        readonly currentLaneKey: string;
        readonly queuedAt: string | null;
        readonly status: string;
      }>`
        SELECT
          current_lane_entry_token AS "currentLaneEntryToken",
          current_lane_key AS "currentLaneKey",
          queued_at AS "queuedAt",
          status
        FROM projection_ticket
        WHERE ticket_id = 't-queue'
      `;
      assert.equal(moved[0]?.currentLaneEntryToken, "tok-moved");
      assert.equal(moved[0]?.currentLaneKey, "done");
      assert.equal(moved[0]?.queuedAt, null);
      assert.equal(moved[0]?.status, "idle");
    }),
  );

  it.effect("projects step lifecycle and waiting_on_user status", () =>
    Effect.gen(function* () {
      const pipeline = yield* WorkflowProjectionPipeline;
      const sql = yield* SqlClient.SqlClient;
      const base = { ticketId: "t-2" as never, occurredAt: "2026-06-07T00:00:00.000Z" as never };

      yield* pipeline.projectEvent({
        ...base,
        type: "TicketCreated",
        eventId: "a" as never,
        streamVersion: 0,
        payload: { boardId: "b-1" as never, title: "Y" as never, laneKey: "implement" as never },
      });
      yield* pipeline.projectEvent({
        ...base,
        type: "PipelineStarted",
        eventId: "b" as never,
        streamVersion: 1,
        payload: {
          pipelineRunId: "pr-1" as never,
          laneKey: "implement" as never,
          laneEntryToken: "tok-1" as never,
        },
      });
      yield* pipeline.projectEvent({
        ...base,
        type: "StepStarted",
        eventId: "c" as never,
        streamVersion: 2,
        payload: {
          pipelineRunId: "pr-1" as never,
          stepRunId: "sr-1" as never,
          stepKey: "code" as never,
          stepType: "agent",
        },
      });
      yield* pipeline.projectEvent({
        ...base,
        type: "StepAwaitingUser",
        eventId: "d" as never,
        streamVersion: 3,
        payload: { stepRunId: "sr-1" as never, waitingReason: "which API?" },
      });

      const ticket = yield* sql<{ readonly status: string }>`
        SELECT status FROM projection_ticket WHERE ticket_id = 't-2'
      `;
      const step = yield* sql<{
        readonly status: string;
        readonly waitingReason: string;
        readonly providerResponseKind: string | null;
      }>`
        SELECT
          status,
          waiting_reason AS "waitingReason",
          provider_response_kind AS "providerResponseKind"
        FROM projection_step_run
        WHERE step_run_id = 'sr-1'
      `;
      assert.equal(ticket[0]?.status, "waiting_on_user");
      assert.equal(step[0]?.status, "awaiting_user");
      assert.equal(step[0]?.waitingReason, "which API?");
      assert.equal(step[0]?.providerResponseKind, null);

      yield* pipeline.projectEvent({
        ...base,
        type: "StepUserResolved",
        eventId: "e" as never,
        streamVersion: 4,
        payload: { stepRunId: "sr-1" as never },
      });
      yield* pipeline.projectEvent({
        ...base,
        type: "StepAwaitingUser",
        eventId: "f" as never,
        streamVersion: 5,
        payload: {
          stepRunId: "sr-1" as never,
          waitingReason: "approve command?",
          providerResponseKind: "request",
        },
      });

      const requestStep = yield* sql<{ readonly providerResponseKind: string | null }>`
        SELECT provider_response_kind AS "providerResponseKind"
        FROM projection_step_run
        WHERE step_run_id = 'sr-1'
      `;
      assert.equal(requestStep[0]?.providerResponseKind, "request");
    }),
  );

  it.effect("projects a blocked step as terminal with its blocked reason", () =>
    Effect.gen(function* () {
      const pipeline = yield* WorkflowProjectionPipeline;
      const sql = yield* SqlClient.SqlClient;
      const base = {
        ticketId: "t-blocked" as never,
        occurredAt: "2026-06-07T00:00:00.000Z" as never,
      };

      yield* pipeline.projectEvent({
        ...base,
        type: "TicketCreated",
        eventId: "blocked-a" as never,
        streamVersion: 0,
        payload: {
          boardId: "b-1" as never,
          title: "Blocked" as never,
          laneKey: "implement" as never,
        },
      });
      yield* pipeline.projectEvent({
        ...base,
        type: "PipelineStarted",
        eventId: "blocked-b" as never,
        streamVersion: 1,
        payload: {
          pipelineRunId: "pr-blocked" as never,
          laneKey: "implement" as never,
          laneEntryToken: "tok-blocked" as never,
        },
      });
      yield* pipeline.projectEvent({
        ...base,
        type: "StepStarted",
        eventId: "blocked-c" as never,
        streamVersion: 2,
        payload: {
          pipelineRunId: "pr-blocked" as never,
          stepRunId: "sr-blocked" as never,
          stepKey: "code" as never,
          stepType: "agent",
        },
      });
      yield* pipeline.projectEvent({
        ...base,
        type: "StepBlocked",
        eventId: "blocked-d" as never,
        streamVersion: 3,
        payload: {
          stepRunId: "sr-blocked" as never,
          reason: "Project not trusted to run scripts",
        },
      } as never);

      const rows = yield* sql<{
        readonly blockedReason: string | null;
        readonly finishedAt: string | null;
        readonly status: string;
      }>`
        SELECT
          status,
          error AS "blockedReason",
          finished_at AS "finishedAt"
        FROM projection_step_run
        WHERE step_run_id = 'sr-blocked'
      `;
      assert.equal(rows[0]?.status, "blocked");
      assert.equal(rows[0]?.blockedReason, "Project not trusted to run scripts");
      assert.isNotNull(rows[0]?.finishedAt ?? null);
    }),
  );

  it.effect("projects TicketPrOpened into workflow_pr_state (initial insert)", () =>
    Effect.gen(function* () {
      const pipeline = yield* WorkflowProjectionPipeline;
      const sql = yield* SqlClient.SqlClient;

      yield* pipeline.projectEvent({
        type: "TicketCreated",
        eventId: "pr-opened-setup-a" as never,
        ticketId: "ticket-pr-opened" as never,
        streamVersion: 0,
        occurredAt: "2026-06-12T00:00:00.000Z" as never,
        payload: {
          boardId: "board-pr-opened" as never,
          title: "PR ticket" as never,
          laneKey: "implement" as never,
        },
      });
      yield* pipeline.projectEvent({
        type: "TicketPrOpened",
        eventId: "pr-opened-b" as never,
        ticketId: "ticket-pr-opened" as never,
        streamVersion: 1,
        occurredAt: "2026-06-12T00:00:01.000Z" as never,
        payload: {
          stepRunId: "sr-pr-opened" as never,
          prNumber: 42,
          url: "https://github.com/owner/repo/pull/42",
          branch: "ft/my-feature",
          remoteName: "origin",
          repo: "owner/repo",
        },
      } as never);

      const rows = yield* sql<{
        readonly ticketId: string;
        readonly prNumber: number;
        readonly prUrl: string;
        readonly branch: string;
        readonly remoteName: string;
        readonly repo: string;
        readonly prState: string;
        readonly updatedAt: string;
        readonly lastHeadSha: string | null;
        readonly lastCiState: string | null;
      }>`
        SELECT
          ticket_id AS "ticketId",
          pr_number AS "prNumber",
          pr_url AS "prUrl",
          branch,
          remote_name AS "remoteName",
          repo,
          pr_state AS "prState",
          updated_at AS "updatedAt",
          last_head_sha AS "lastHeadSha",
          last_ci_state AS "lastCiState"
        FROM workflow_pr_state
        WHERE ticket_id = 'ticket-pr-opened'
      `;

      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.ticketId, "ticket-pr-opened");
      assert.equal(rows[0]?.prNumber, 42);
      assert.equal(rows[0]?.prUrl, "https://github.com/owner/repo/pull/42");
      assert.equal(rows[0]?.branch, "ft/my-feature");
      assert.equal(rows[0]?.remoteName, "origin");
      assert.equal(rows[0]?.repo, "owner/repo");
      assert.equal(rows[0]?.prState, "open");
      assert.equal(rows[0]?.updatedAt, "2026-06-12T00:00:01.000Z");
      assert.equal(rows[0]?.lastHeadSha, null);
      assert.equal(rows[0]?.lastCiState, null);
    }),
  );

  it.effect("projecting TicketPrOpened twice is idempotent (upsert)", () =>
    Effect.gen(function* () {
      const pipeline = yield* WorkflowProjectionPipeline;
      const sql = yield* SqlClient.SqlClient;

      yield* pipeline.projectEvent({
        type: "TicketCreated",
        eventId: "pr-replay-setup" as never,
        ticketId: "ticket-pr-replay" as never,
        streamVersion: 0,
        occurredAt: "2026-06-12T00:00:00.000Z" as never,
        payload: {
          boardId: "board-pr-replay" as never,
          title: "PR replay ticket" as never,
          laneKey: "implement" as never,
        },
      });
      const prEvent = {
        type: "TicketPrOpened" as const,
        eventId: "pr-replay-b" as never,
        ticketId: "ticket-pr-replay" as never,
        streamVersion: 1,
        occurredAt: "2026-06-12T00:00:01.000Z" as never,
        payload: {
          stepRunId: "sr-pr-replay" as never,
          prNumber: 7,
          url: "https://github.com/owner/repo/pull/7",
          branch: "ft/replay",
          remoteName: "upstream",
          repo: "owner/repo",
        },
      };
      yield* pipeline.projectEvent(prEvent as never);
      yield* pipeline.projectEvent(prEvent as never);

      const rows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM workflow_pr_state WHERE ticket_id = 'ticket-pr-replay'
      `;
      assert.equal(rows[0]?.count, 1);
    }),
  );

  it.effect("projects script step start and exit into workflow_script_run", () =>
    Effect.gen(function* () {
      const pipeline = yield* WorkflowProjectionPipeline;
      const sql = yield* SqlClient.SqlClient;
      const base = {
        ticketId: "t-script-projection" as never,
        occurredAt: "2026-06-07T00:00:00.000Z" as never,
      };

      yield* pipeline.projectEvent({
        ...base,
        type: "TicketCreated",
        eventId: "script-projection-a" as never,
        streamVersion: 0,
        payload: {
          boardId: "b-script" as never,
          title: "Script projection" as never,
          laneKey: "implement" as never,
        },
      });
      yield* pipeline.projectEvent({
        ...base,
        type: "PipelineStarted",
        eventId: "script-projection-b" as never,
        streamVersion: 1,
        payload: {
          pipelineRunId: "pr-script-projection" as never,
          laneKey: "implement" as never,
          laneEntryToken: "tok-script-projection" as never,
        },
      });
      yield* pipeline.projectEvent({
        ...base,
        type: "StepStarted",
        eventId: "script-projection-c" as never,
        streamVersion: 2,
        payload: {
          pipelineRunId: "pr-script-projection" as never,
          stepRunId: "sr-script-projection" as never,
          stepKey: "tests" as never,
          stepType: "script",
        },
      });
      yield* pipeline.projectEvent({
        ...base,
        type: "ScriptStepStarted",
        eventId: "script-projection-d" as never,
        streamVersion: 3,
        payload: {
          scriptRunId: "script-run-projection" as never,
          stepRunId: "sr-script-projection" as never,
          scriptThreadId: "workflow-script:script-run-projection" as never,
          terminalId: "script-script-run-projection" as never,
        },
      });
      yield* pipeline.projectEvent({
        ...base,
        type: "ScriptStepExited",
        eventId: "script-projection-e" as never,
        streamVersion: 4,
        payload: {
          scriptRunId: "script-run-projection" as never,
          exitCode: 7,
          signal: null,
          outcome: "exited",
        },
      });

      const rows = yield* sql<{
        readonly exitCode: number | null;
        readonly scriptThreadId: string;
        readonly signal: number | null;
        readonly status: string;
        readonly terminalId: string;
      }>`
        SELECT
          script_thread_id AS "scriptThreadId",
          terminal_id AS "terminalId",
          status,
          exit_code AS "exitCode",
          signal
        FROM workflow_script_run
        WHERE script_run_id = 'script-run-projection'
      `;

      assert.equal(rows[0]?.scriptThreadId, "workflow-script:script-run-projection");
      assert.equal(rows[0]?.terminalId, "script-script-run-projection");
      assert.equal(rows[0]?.status, "exited");
      assert.equal(rows[0]?.exitCode, 7);
      assert.equal(rows[0]?.signal, null);
    }),
  );

  it.effect(
    "StepAwaitingUser with providerResponseKind=request sets attention_kind=waiting_for_approval",
    () =>
      Effect.gen(function* () {
        const pipeline = yield* WorkflowProjectionPipeline;
        const sql = yield* SqlClient.SqlClient;
        const base = {
          ticketId: "t-attn-approval" as never,
          occurredAt: "2026-06-13T00:00:00.000Z" as never,
        };

        yield* pipeline.projectEvent({
          ...base,
          type: "TicketCreated",
          eventId: "attn-approval-a" as never,
          streamVersion: 0,
          payload: {
            boardId: "b-attn" as never,
            title: "Approval ticket" as never,
            laneKey: "implement" as never,
          },
        });
        yield* pipeline.projectEvent({
          ...base,
          type: "PipelineStarted",
          eventId: "attn-approval-b" as never,
          streamVersion: 1,
          payload: {
            pipelineRunId: "pr-attn-approval" as never,
            laneKey: "implement" as never,
            laneEntryToken: "tok-attn-approval" as never,
          },
        });
        yield* pipeline.projectEvent({
          ...base,
          type: "StepStarted",
          eventId: "attn-approval-c" as never,
          streamVersion: 2,
          payload: {
            pipelineRunId: "pr-attn-approval" as never,
            stepRunId: "sr-attn-approval" as never,
            stepKey: "code" as never,
            stepType: "agent",
          },
        });
        yield* pipeline.projectEvent({
          ...base,
          type: "StepAwaitingUser",
          eventId: "attn-approval-d" as never,
          streamVersion: 3,
          payload: {
            stepRunId: "sr-attn-approval" as never,
            waitingReason: "approve shell command?",
            providerResponseKind: "request",
          },
        });

        const rows = yield* sql<{
          readonly status: string;
          readonly attentionKind: string | null;
          readonly attentionReason: string | null;
        }>`
          SELECT
            status,
            attention_kind AS "attentionKind",
            attention_reason AS "attentionReason"
          FROM projection_ticket
          WHERE ticket_id = 't-attn-approval'
        `;
        assert.equal(rows[0]?.status, "waiting_on_user");
        assert.equal(rows[0]?.attentionKind, "waiting_for_approval");
        assert.equal(rows[0]?.attentionReason, "approve shell command?");
      }),
  );

  it.effect(
    "StepAwaitingUser with providerResponseKind=user-input sets attention_kind=waiting_for_input",
    () =>
      Effect.gen(function* () {
        const pipeline = yield* WorkflowProjectionPipeline;
        const sql = yield* SqlClient.SqlClient;
        const base = {
          ticketId: "t-attn-input" as never,
          occurredAt: "2026-06-13T00:00:00.000Z" as never,
        };

        yield* pipeline.projectEvent({
          ...base,
          type: "TicketCreated",
          eventId: "attn-input-a" as never,
          streamVersion: 0,
          payload: {
            boardId: "b-attn" as never,
            title: "Input ticket" as never,
            laneKey: "implement" as never,
          },
        });
        yield* pipeline.projectEvent({
          ...base,
          type: "PipelineStarted",
          eventId: "attn-input-b" as never,
          streamVersion: 1,
          payload: {
            pipelineRunId: "pr-attn-input" as never,
            laneKey: "implement" as never,
            laneEntryToken: "tok-attn-input" as never,
          },
        });
        yield* pipeline.projectEvent({
          ...base,
          type: "StepStarted",
          eventId: "attn-input-c" as never,
          streamVersion: 2,
          payload: {
            pipelineRunId: "pr-attn-input" as never,
            stepRunId: "sr-attn-input" as never,
            stepKey: "code" as never,
            stepType: "agent",
          },
        });
        yield* pipeline.projectEvent({
          ...base,
          type: "StepAwaitingUser",
          eventId: "attn-input-d" as never,
          streamVersion: 3,
          payload: {
            stepRunId: "sr-attn-input" as never,
            waitingReason: "which endpoint?",
            providerResponseKind: "user-input",
          },
        });

        const rows = yield* sql<{
          readonly attentionKind: string | null;
          readonly attentionReason: string | null;
        }>`
          SELECT
            attention_kind AS "attentionKind",
            attention_reason AS "attentionReason"
          FROM projection_ticket
          WHERE ticket_id = 't-attn-input'
        `;
        assert.equal(rows[0]?.attentionKind, "waiting_for_input");
        assert.equal(rows[0]?.attentionReason, "which endpoint?");
      }),
  );

  it.effect(
    "StepAwaitingUser without providerResponseKind sets attention_kind=waiting_for_input",
    () =>
      Effect.gen(function* () {
        const pipeline = yield* WorkflowProjectionPipeline;
        const sql = yield* SqlClient.SqlClient;
        const base = {
          ticketId: "t-attn-null-kind" as never,
          occurredAt: "2026-06-13T00:00:00.000Z" as never,
        };

        yield* pipeline.projectEvent({
          ...base,
          type: "TicketCreated",
          eventId: "attn-null-kind-a" as never,
          streamVersion: 0,
          payload: {
            boardId: "b-attn" as never,
            title: "No-kind ticket" as never,
            laneKey: "implement" as never,
          },
        });
        yield* pipeline.projectEvent({
          ...base,
          type: "PipelineStarted",
          eventId: "attn-null-kind-b" as never,
          streamVersion: 1,
          payload: {
            pipelineRunId: "pr-attn-null-kind" as never,
            laneKey: "implement" as never,
            laneEntryToken: "tok-attn-null-kind" as never,
          },
        });
        yield* pipeline.projectEvent({
          ...base,
          type: "StepStarted",
          eventId: "attn-null-kind-c" as never,
          streamVersion: 2,
          payload: {
            pipelineRunId: "pr-attn-null-kind" as never,
            stepRunId: "sr-attn-null-kind" as never,
            stepKey: "code" as never,
            stepType: "agent",
          },
        });
        yield* pipeline.projectEvent({
          ...base,
          type: "StepAwaitingUser",
          eventId: "attn-null-kind-d" as never,
          streamVersion: 3,
          payload: {
            stepRunId: "sr-attn-null-kind" as never,
            waitingReason: "what to do?",
          },
        });

        const rows = yield* sql<{
          readonly attentionKind: string | null;
          readonly attentionReason: string | null;
        }>`
          SELECT
            attention_kind AS "attentionKind",
            attention_reason AS "attentionReason"
          FROM projection_ticket
          WHERE ticket_id = 't-attn-null-kind'
        `;
        assert.equal(rows[0]?.attentionKind, "waiting_for_input");
        assert.equal(rows[0]?.attentionReason, "what to do?");
      }),
  );

  it.effect("TicketBlocked sets attention_kind=blocked and attention_reason", () =>
    Effect.gen(function* () {
      const pipeline = yield* WorkflowProjectionPipeline;
      const sql = yield* SqlClient.SqlClient;
      const base = {
        ticketId: "t-attn-blocked" as never,
        occurredAt: "2026-06-13T00:00:00.000Z" as never,
      };

      yield* pipeline.projectEvent({
        ...base,
        type: "TicketCreated",
        eventId: "attn-blocked-a" as never,
        streamVersion: 0,
        payload: {
          boardId: "b-attn" as never,
          title: "Blocked ticket" as never,
          laneKey: "implement" as never,
        },
      });
      yield* pipeline.projectEvent({
        ...base,
        type: "TicketBlocked",
        eventId: "attn-blocked-b" as never,
        streamVersion: 1,
        payload: { reason: "missing credentials" },
      });

      const rows = yield* sql<{
        readonly status: string;
        readonly attentionKind: string | null;
        readonly attentionReason: string | null;
      }>`
        SELECT
          status,
          attention_kind AS "attentionKind",
          attention_reason AS "attentionReason"
        FROM projection_ticket
        WHERE ticket_id = 't-attn-blocked'
      `;
      assert.equal(rows[0]?.status, "blocked");
      assert.equal(rows[0]?.attentionKind, "blocked");
      assert.equal(rows[0]?.attentionReason, "missing credentials");
    }),
  );

  it.effect(
    "StepUserResolved after StepAwaitingUser clears attention_kind and attention_reason",
    () =>
      Effect.gen(function* () {
        const pipeline = yield* WorkflowProjectionPipeline;
        const sql = yield* SqlClient.SqlClient;
        const base = {
          ticketId: "t-attn-clear-resolved" as never,
          occurredAt: "2026-06-13T00:00:00.000Z" as never,
        };

        yield* pipeline.projectEvent({
          ...base,
          type: "TicketCreated",
          eventId: "attn-clear-resolved-a" as never,
          streamVersion: 0,
          payload: {
            boardId: "b-attn" as never,
            title: "Clear resolved ticket" as never,
            laneKey: "implement" as never,
          },
        });
        yield* pipeline.projectEvent({
          ...base,
          type: "PipelineStarted",
          eventId: "attn-clear-resolved-b" as never,
          streamVersion: 1,
          payload: {
            pipelineRunId: "pr-attn-clear-resolved" as never,
            laneKey: "implement" as never,
            laneEntryToken: "tok-attn-clear-resolved" as never,
          },
        });
        yield* pipeline.projectEvent({
          ...base,
          type: "StepStarted",
          eventId: "attn-clear-resolved-c" as never,
          streamVersion: 2,
          payload: {
            pipelineRunId: "pr-attn-clear-resolved" as never,
            stepRunId: "sr-attn-clear-resolved" as never,
            stepKey: "code" as never,
            stepType: "agent",
          },
        });
        yield* pipeline.projectEvent({
          ...base,
          type: "StepAwaitingUser",
          eventId: "attn-clear-resolved-d" as never,
          streamVersion: 3,
          payload: {
            stepRunId: "sr-attn-clear-resolved" as never,
            waitingReason: "approve command?",
            providerResponseKind: "request",
          },
        });
        yield* pipeline.projectEvent({
          ...base,
          type: "StepUserResolved",
          eventId: "attn-clear-resolved-e" as never,
          streamVersion: 4,
          payload: { stepRunId: "sr-attn-clear-resolved" as never },
        });

        const rows = yield* sql<{
          readonly status: string;
          readonly attentionKind: string | null;
          readonly attentionReason: string | null;
        }>`
          SELECT
            status,
            attention_kind AS "attentionKind",
            attention_reason AS "attentionReason"
          FROM projection_ticket
          WHERE ticket_id = 't-attn-clear-resolved'
        `;
        assert.equal(rows[0]?.status, "running");
        assert.isNull(rows[0]?.attentionKind);
        assert.isNull(rows[0]?.attentionReason);
      }),
  );

  it.effect(
    "TicketMovedToLane after TicketBlocked clears attention_kind and attention_reason",
    () =>
      Effect.gen(function* () {
        const pipeline = yield* WorkflowProjectionPipeline;
        const sql = yield* SqlClient.SqlClient;
        const base = {
          ticketId: "t-attn-clear-moved" as never,
          occurredAt: "2026-06-13T00:00:00.000Z" as never,
        };

        yield* pipeline.projectEvent({
          ...base,
          type: "TicketCreated",
          eventId: "attn-clear-moved-a" as never,
          streamVersion: 0,
          payload: {
            boardId: "b-attn" as never,
            title: "Clear moved ticket" as never,
            laneKey: "implement" as never,
          },
        });
        yield* pipeline.projectEvent({
          ...base,
          type: "TicketBlocked",
          eventId: "attn-clear-moved-b" as never,
          streamVersion: 1,
          payload: { reason: "blocked for now" },
        });
        yield* pipeline.projectEvent({
          ...base,
          type: "TicketMovedToLane",
          eventId: "attn-clear-moved-c" as never,
          streamVersion: 2,
          occurredAt: "2026-06-13T00:00:01.000Z" as never,
          payload: {
            toLane: "review" as never,
            laneEntryToken: "tok-attn-clear-moved" as never,
            reason: "manual",
          },
        });

        const rows = yield* sql<{
          readonly status: string;
          readonly attentionKind: string | null;
          readonly attentionReason: string | null;
        }>`
          SELECT
            status,
            attention_kind AS "attentionKind",
            attention_reason AS "attentionReason"
          FROM projection_ticket
          WHERE ticket_id = 't-attn-clear-moved'
        `;
        assert.equal(rows[0]?.status, "idle");
        assert.isNull(rows[0]?.attentionKind);
        assert.isNull(rows[0]?.attentionReason);
      }),
  );

  it.effect("TicketAdmitted sets current_lane_entered_at to the event's occurredAt", () =>
    Effect.gen(function* () {
      const pipeline = yield* WorkflowProjectionPipeline;
      const sql = yield* SqlClient.SqlClient;
      const base = {
        ticketId: "t-entered-at-admit" as never,
        occurredAt: "2026-06-14T10:00:00.000Z" as never,
      };

      yield* pipeline.projectEvent({
        ...base,
        type: "TicketCreated",
        eventId: "entered-at-admit-a" as never,
        streamVersion: 0,
        payload: {
          boardId: "b-entered-at" as never,
          title: "Entered at admit" as never,
          laneKey: "backlog" as never,
        },
      });
      yield* pipeline.projectEvent({
        ...base,
        type: "TicketQueued",
        eventId: "entered-at-admit-b" as never,
        streamVersion: 1,
        occurredAt: "2026-06-14T10:00:01.000Z" as never,
        payload: { lane: "implement" as never },
      } as never);
      yield* pipeline.projectEvent({
        ...base,
        type: "TicketAdmitted",
        eventId: "entered-at-admit-c" as never,
        streamVersion: 2,
        occurredAt: "2026-06-14T10:00:02.000Z" as never,
        payload: {
          lane: "implement" as never,
          laneEntryToken: "tok-entered-at-admit" as never,
        },
      } as never);

      const rows = yield* sql<{
        readonly currentLaneEnteredAt: string | null;
      }>`
        SELECT current_lane_entered_at AS "currentLaneEnteredAt"
        FROM projection_ticket
        WHERE ticket_id = 't-entered-at-admit'
      `;
      assert.equal(rows[0]?.currentLaneEnteredAt, "2026-06-14T10:00:02.000Z");
    }),
  );

  it.effect("TicketMovedToLane sets current_lane_entered_at to the event's occurredAt", () =>
    Effect.gen(function* () {
      const pipeline = yield* WorkflowProjectionPipeline;
      const sql = yield* SqlClient.SqlClient;
      const base = {
        ticketId: "t-entered-at-move" as never,
        occurredAt: "2026-06-14T11:00:00.000Z" as never,
      };

      yield* pipeline.projectEvent({
        ...base,
        type: "TicketCreated",
        eventId: "entered-at-move-a" as never,
        streamVersion: 0,
        payload: {
          boardId: "b-entered-at" as never,
          title: "Entered at move" as never,
          laneKey: "backlog" as never,
        },
      });
      yield* pipeline.projectEvent({
        ...base,
        type: "TicketMovedToLane",
        eventId: "entered-at-move-b" as never,
        streamVersion: 1,
        occurredAt: "2026-06-14T11:00:01.000Z" as never,
        payload: {
          toLane: "implement" as never,
          laneEntryToken: "tok-entered-at-move-1" as never,
          reason: "manual",
        },
      });

      const afterFirst = yield* sql<{
        readonly currentLaneEnteredAt: string | null;
      }>`
        SELECT current_lane_entered_at AS "currentLaneEnteredAt"
        FROM projection_ticket
        WHERE ticket_id = 't-entered-at-move'
      `;
      assert.equal(afterFirst[0]?.currentLaneEnteredAt, "2026-06-14T11:00:01.000Z");

      yield* pipeline.projectEvent({
        ...base,
        type: "TicketMovedToLane",
        eventId: "entered-at-move-c" as never,
        streamVersion: 2,
        occurredAt: "2026-06-14T11:00:05.000Z" as never,
        payload: {
          toLane: "review" as never,
          laneEntryToken: "tok-entered-at-move-2" as never,
          reason: "manual",
        },
      });

      const afterSecond = yield* sql<{
        readonly currentLaneEnteredAt: string | null;
      }>`
        SELECT current_lane_entered_at AS "currentLaneEnteredAt"
        FROM projection_ticket
        WHERE ticket_id = 't-entered-at-move'
      `;
      assert.equal(afterSecond[0]?.currentLaneEnteredAt, "2026-06-14T11:00:05.000Z");
    }),
  );

  it.effect("TicketQueued does NOT set current_lane_entered_at", () =>
    Effect.gen(function* () {
      const pipeline = yield* WorkflowProjectionPipeline;
      const sql = yield* SqlClient.SqlClient;
      const base = {
        ticketId: "t-entered-at-queued" as never,
        occurredAt: "2026-06-14T12:00:00.000Z" as never,
      };

      yield* pipeline.projectEvent({
        ...base,
        type: "TicketCreated",
        eventId: "entered-at-queued-a" as never,
        streamVersion: 0,
        payload: {
          boardId: "b-entered-at" as never,
          title: "Entered at queued" as never,
          laneKey: "backlog" as never,
        },
      });

      // First admit to set current_lane_entered_at to a known value
      yield* pipeline.projectEvent({
        ...base,
        type: "TicketAdmitted",
        eventId: "entered-at-queued-b" as never,
        streamVersion: 1,
        occurredAt: "2026-06-14T12:00:01.000Z" as never,
        payload: {
          lane: "backlog" as never,
          laneEntryToken: "tok-entered-at-queued-1" as never,
        },
      } as never);

      // Now queue to a new lane — this must NOT change current_lane_entered_at
      yield* pipeline.projectEvent({
        ...base,
        type: "TicketQueued",
        eventId: "entered-at-queued-c" as never,
        streamVersion: 2,
        occurredAt: "2026-06-14T12:00:02.000Z" as never,
        payload: { lane: "implement" as never },
      } as never);

      const rows = yield* sql<{
        readonly currentLaneEnteredAt: string | null;
      }>`
        SELECT current_lane_entered_at AS "currentLaneEnteredAt"
        FROM projection_ticket
        WHERE ticket_id = 't-entered-at-queued'
      `;
      // Must still be the admit time, not the queued time
      assert.equal(rows[0]?.currentLaneEnteredAt, "2026-06-14T12:00:01.000Z");
    }),
  );
});
