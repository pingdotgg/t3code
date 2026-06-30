import {
  TicketAttachment,
  type BoardId,
  type LaneKey,
  type WorkflowEvent,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { BoardRegistry } from "../Services/BoardRegistry.ts";
import { WorkflowEventStoreError } from "../Services/Errors.ts";
import {
  WorkflowProjectionPipeline,
  type WorkflowProjectionPipelineShape,
} from "../Services/WorkflowProjectionPipeline.ts";

const toProjectionError = (cause: unknown) =>
  new WorkflowEventStoreError({ message: "projection failed", cause });

const encodeOutputJson = Schema.encodeUnknownEffect(Schema.UnknownFromJsonString);
const encodeTicketAttachmentsJson = Schema.encodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(TicketAttachment)),
);

const encodeStepOutput = (output: unknown) =>
  output === undefined ? Effect.succeed(null) : encodeOutputJson(output);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const getOptionalServices = Effect.context<never>().pipe(
    Effect.map((context) => ({
      registry: Context.getOption(context as Context.Context<BoardRegistry>, BoardRegistry),
    })),
  );

  const isTerminalLane = (boardId: BoardId, laneKey: LaneKey) =>
    Effect.gen(function* () {
      const { registry } = yield* getOptionalServices;
      if (Option.isNone(registry)) {
        return false;
      }
      const lane = yield* registry.value.getLane(boardId, laneKey);
      return lane?.terminal === true;
    });

  const terminalAtForBoardLane = (boardId: BoardId, laneKey: LaneKey, occurredAt: string) =>
    isTerminalLane(boardId, laneKey).pipe(
      Effect.map((isTerminal) => (isTerminal ? occurredAt : null)),
    );

  const terminalAtForTicketLane = (ticketId: string, laneKey: LaneKey, occurredAt: string) =>
    Effect.gen(function* () {
      const rows = yield* sql<{
        readonly boardId: BoardId;
        readonly currentLaneKey: LaneKey;
        readonly terminalAt: string | null;
      }>`
        SELECT
          board_id AS "boardId",
          current_lane_key AS "currentLaneKey",
          terminal_at AS "terminalAt"
        FROM projection_ticket
        WHERE ticket_id = ${ticketId}
      `;
      const row = rows[0];
      if (!row) {
        return null;
      }
      if (!(yield* isTerminalLane(row.boardId, laneKey))) {
        return null;
      }
      return row.currentLaneKey === laneKey && row.terminalAt !== null
        ? row.terminalAt
        : occurredAt;
    });

  const projectEvent: WorkflowProjectionPipelineShape["projectEvent"] = (event: WorkflowEvent) =>
    Effect.gen(function* () {
      switch (event.type) {
        case "TicketCreated": {
          const terminalAt = yield* terminalAtForBoardLane(
            event.payload.boardId,
            event.payload.laneKey,
            event.occurredAt,
          );
          yield* sql`
            INSERT INTO projection_ticket (
              ticket_id,
              board_id,
              title,
              description,
              current_lane_key,
              status,
              terminal_at,
              token_budget,
              created_at,
              updated_at
            )
            VALUES (
              ${event.ticketId},
              ${event.payload.boardId},
              ${event.payload.title},
              ${event.payload.description ?? null},
              ${event.payload.laneKey},
              'idle',
              ${terminalAt},
              ${event.payload.tokenBudget ?? null},
              ${event.occurredAt},
              ${event.occurredAt}
            )
            ON CONFLICT(ticket_id) DO NOTHING
          `;
          break;
        }
        case "TicketMovedToLane": {
          const terminalAt = yield* terminalAtForTicketLane(
            event.ticketId,
            event.payload.toLane,
            event.occurredAt,
          );
          yield* sql`
            UPDATE projection_ticket
            SET current_lane_key = ${event.payload.toLane},
                status = 'idle',
                attention_kind = NULL,
                attention_reason = NULL,
                current_lane_entry_token = ${event.payload.laneEntryToken},
                current_lane_entered_at = ${event.occurredAt},
                queued_at = NULL,
                terminal_at = ${terminalAt},
                updated_at = ${event.occurredAt}
            WHERE ticket_id = ${event.ticketId}
          `;
          break;
        }
        case "TicketEdited": {
          const hasTitle = Object.prototype.hasOwnProperty.call(event.payload, "title");
          const hasDescription = Object.prototype.hasOwnProperty.call(event.payload, "description");
          const hasTokenBudget = Object.prototype.hasOwnProperty.call(event.payload, "tokenBudget");
          yield* sql`
            UPDATE projection_ticket
            SET title = CASE
                  WHEN ${hasTitle ? 1 : 0} = 1 THEN ${event.payload.title ?? ""}
                  ELSE title
                END,
                description = CASE
                  WHEN ${hasDescription ? 1 : 0} = 1 THEN ${event.payload.description ?? ""}
                  ELSE description
                END,
                token_budget = CASE
                  WHEN ${hasTokenBudget ? 1 : 0} = 1 THEN ${event.payload.tokenBudget ?? null}
                  ELSE token_budget
                END,
                updated_at = ${event.occurredAt}
            WHERE ticket_id = ${event.ticketId}
          `;
          break;
        }
        case "TicketDependenciesSet": {
          yield* sql`
            DELETE FROM projection_ticket_dependency
            WHERE ticket_id = ${event.ticketId}
          `;
          yield* Effect.forEach(
            event.payload.dependsOn,
            (dependsOn) => sql`
              INSERT INTO projection_ticket_dependency (ticket_id, depends_on_ticket_id)
              VALUES (${event.ticketId}, ${dependsOn})
              ON CONFLICT DO NOTHING
            `,
            { discard: true },
          );
          break;
        }
        case "TicketMessagePosted": {
          const attachmentsJson = yield* encodeTicketAttachmentsJson(event.payload.attachments);
          yield* sql`
            INSERT INTO projection_ticket_message (
              message_id,
              ticket_id,
              step_run_id,
              author,
              body,
              attachments_json,
              created_at
            )
            VALUES (
              ${event.payload.messageId},
              ${event.ticketId},
              ${event.payload.stepRunId ?? null},
              ${event.payload.author},
              ${event.payload.body},
              ${attachmentsJson},
              ${event.payload.createdAt}
            )
            ON CONFLICT(message_id) DO UPDATE SET
              ticket_id = excluded.ticket_id,
              step_run_id = excluded.step_run_id,
              author = excluded.author,
              body = excluded.body,
              attachments_json = excluded.attachments_json,
              created_at = excluded.created_at
          `;
          break;
        }
        case "TicketMessageEdited": {
          yield* sql`
            UPDATE projection_ticket_message
            SET body = ${event.payload.body}, edited_at = ${event.payload.editedAt}
            WHERE message_id = ${event.payload.messageId}
          `;
          break;
        }
        case "TicketQueued": {
          yield* sql`
            UPDATE projection_ticket
            SET current_lane_key = ${event.payload.lane},
                status = 'queued',
                attention_kind = NULL,
                attention_reason = NULL,
                current_lane_entry_token = NULL,
                queued_at = ${event.occurredAt},
                terminal_at = NULL,
                updated_at = ${event.occurredAt}
            WHERE ticket_id = ${event.ticketId}
          `;
          break;
        }
        case "TicketAdmitted": {
          const terminalAt = yield* terminalAtForTicketLane(
            event.ticketId,
            event.payload.lane,
            event.occurredAt,
          );
          yield* sql`
            UPDATE projection_ticket
            SET current_lane_key = ${event.payload.lane},
                status = 'idle',
                attention_kind = NULL,
                attention_reason = NULL,
                current_lane_entry_token = ${event.payload.laneEntryToken},
                current_lane_entered_at = ${event.occurredAt},
                queued_at = NULL,
                terminal_at = ${terminalAt},
                updated_at = ${event.occurredAt}
            WHERE ticket_id = ${event.ticketId}
          `;
          break;
        }
        case "TicketRouted": {
          const terminalAt = yield* terminalAtForTicketLane(
            event.ticketId,
            event.payload.toLane,
            event.occurredAt,
          );
          yield* sql`
            UPDATE projection_ticket
            SET current_lane_key = ${event.payload.toLane},
                terminal_at = ${terminalAt},
                updated_at = ${event.occurredAt}
            WHERE ticket_id = ${event.ticketId}
          `;
          break;
        }
        case "TicketBlocked": {
          yield* sql`
            UPDATE projection_ticket
            SET status = 'blocked',
                attention_kind = 'blocked',
                attention_reason = ${event.payload.reason},
                updated_at = ${event.occurredAt}
            WHERE ticket_id = ${event.ticketId}
          `;
          break;
        }
        case "PipelineStarted": {
          yield* sql`
            INSERT INTO projection_pipeline_run (
              pipeline_run_id,
              ticket_id,
              lane_key,
              lane_entry_token,
              status,
              started_at
            )
            VALUES (
              ${event.payload.pipelineRunId},
              ${event.ticketId},
              ${event.payload.laneKey},
              ${event.payload.laneEntryToken},
              'running',
              ${event.occurredAt}
            )
            ON CONFLICT(pipeline_run_id) DO NOTHING
          `;
          yield* sql`
            UPDATE projection_ticket
            SET status = 'running',
                attention_kind = NULL,
                attention_reason = NULL,
                updated_at = ${event.occurredAt}
            WHERE ticket_id = ${event.ticketId}
          `;
          break;
        }
        case "PipelineCompleted": {
          yield* sql`
            UPDATE projection_pipeline_run
            SET status = ${event.payload.result},
                finished_at = ${event.occurredAt}
            WHERE pipeline_run_id = ${event.payload.pipelineRunId}
          `;
          break;
        }
        case "StepStarted": {
          yield* sql`
            INSERT INTO projection_step_run (
              step_run_id,
              pipeline_run_id,
              ticket_id,
              step_key,
              step_type,
              attempt,
              status,
              started_at
            )
            VALUES (
              ${event.payload.stepRunId},
              ${event.payload.pipelineRunId},
              ${event.ticketId},
              ${event.payload.stepKey},
              ${event.payload.stepType},
              ${event.payload.attempt ?? 1},
              'running',
              ${event.occurredAt}
            )
            ON CONFLICT(step_run_id) DO NOTHING
          `;
          break;
        }
        case "StepAwaitingUser": {
          yield* sql`
            UPDATE projection_step_run
            SET status = 'awaiting_user',
                waiting_reason = ${event.payload.waitingReason},
                provider_response_kind = ${event.payload.providerResponseKind ?? null}
            WHERE step_run_id = ${event.payload.stepRunId}
          `;
          yield* sql`
            UPDATE projection_ticket
            SET status = 'waiting_on_user',
                attention_kind = ${event.payload.providerResponseKind === "request" ? "waiting_for_approval" : "waiting_for_input"},
                attention_reason = ${event.payload.waitingReason},
                updated_at = ${event.occurredAt}
            WHERE ticket_id = ${event.ticketId}
          `;
          break;
        }
        case "StepUserResolved": {
          yield* sql`
            UPDATE projection_step_run
            SET status = 'running',
                waiting_reason = NULL,
                provider_response_kind = NULL
            WHERE step_run_id = ${event.payload.stepRunId}
          `;
          yield* sql`
            UPDATE projection_ticket
            SET status = 'running',
                attention_kind = NULL,
                attention_reason = NULL,
                updated_at = ${event.occurredAt}
            WHERE ticket_id = ${event.ticketId}
          `;
          break;
        }
        case "StepRefsCaptured": {
          yield* sql`
            UPDATE projection_step_run
            SET pre_checkpoint_ref = ${event.payload.preRef},
                post_checkpoint_ref = ${event.payload.postRef}
            WHERE step_run_id = ${event.payload.stepRunId}
          `;
          break;
        }
        case "StepCompleted": {
          const outputJson = yield* encodeStepOutput(event.payload.output);
          const usage = event.payload.usage;
          yield* sql`
            UPDATE projection_step_run
            SET status = 'completed',
                waiting_reason = NULL,
                provider_response_kind = NULL,
                output_json = ${outputJson},
                input_tokens = ${usage?.inputTokens ?? null},
                cached_input_tokens = ${usage?.cachedInputTokens ?? null},
                output_tokens = ${usage?.outputTokens ?? null},
                total_tokens = ${usage?.totalTokens ?? null},
                finished_at = ${event.occurredAt}
            WHERE step_run_id = ${event.payload.stepRunId}
          `;
          break;
        }
        case "StepFailed": {
          const usage = event.payload.usage;
          yield* sql`
            UPDATE projection_step_run
            SET status = 'failed',
                waiting_reason = NULL,
                provider_response_kind = NULL,
                error = ${event.payload.error},
                retryable = ${event.payload.retryable === undefined ? null : event.payload.retryable ? 1 : 0},
                input_tokens = ${usage?.inputTokens ?? null},
                cached_input_tokens = ${usage?.cachedInputTokens ?? null},
                output_tokens = ${usage?.outputTokens ?? null},
                total_tokens = ${usage?.totalTokens ?? null},
                finished_at = ${event.occurredAt}
            WHERE step_run_id = ${event.payload.stepRunId}
          `;
          break;
        }
        case "StepBlocked": {
          yield* sql`
            UPDATE projection_step_run
            SET status = 'blocked',
                waiting_reason = NULL,
                provider_response_kind = NULL,
                error = ${event.payload.reason},
                finished_at = ${event.occurredAt}
            WHERE step_run_id = ${event.payload.stepRunId}
          `;
          break;
        }
        case "ScriptStepStarted": {
          yield* sql`
            INSERT INTO workflow_script_run (
              script_run_id,
              step_run_id,
              ticket_id,
              script_thread_id,
              terminal_id,
              status,
              started_at
            )
            VALUES (
              ${event.payload.scriptRunId},
              ${event.payload.stepRunId},
              ${event.ticketId},
              ${event.payload.scriptThreadId},
              ${event.payload.terminalId},
              'running',
              ${event.occurredAt}
            )
            ON CONFLICT(script_run_id) DO UPDATE SET
              step_run_id = excluded.step_run_id,
              ticket_id = excluded.ticket_id,
              script_thread_id = excluded.script_thread_id,
              terminal_id = excluded.terminal_id,
              status = 'running',
              exit_code = NULL,
              signal = NULL,
              started_at = excluded.started_at,
              finished_at = NULL
          `;
          break;
        }
        case "ScriptStepExited": {
          yield* sql`
            UPDATE workflow_script_run
            SET status = ${event.payload.outcome},
                exit_code = ${event.payload.exitCode},
                signal = ${event.payload.signal},
                finished_at = ${event.occurredAt}
            WHERE script_run_id = ${event.payload.scriptRunId}
          `;
          break;
        }
        case "TicketPrOpened": {
          yield* sql`
            INSERT INTO workflow_pr_state (
              ticket_id,
              pr_number,
              pr_url,
              branch,
              remote_name,
              repo,
              pr_state,
              updated_at
            )
            VALUES (
              ${event.ticketId},
              ${event.payload.prNumber},
              ${event.payload.url},
              ${event.payload.branch},
              ${event.payload.remoteName},
              ${event.payload.repo},
              'open',
              ${event.occurredAt}
            )
            ON CONFLICT(ticket_id) DO UPDATE SET
              pr_number = excluded.pr_number,
              pr_url = excluded.pr_url,
              branch = excluded.branch,
              remote_name = excluded.remote_name,
              repo = excluded.repo,
              pr_state = 'open',
              updated_at = excluded.updated_at
          `;
          break;
        }
      }
    }).pipe(Effect.mapError(toProjectionError), Effect.asVoid);

  return { projectEvent } satisfies WorkflowProjectionPipelineShape;
});

export const WorkflowProjectionPipelineLive = Layer.effect(WorkflowProjectionPipeline, make);
