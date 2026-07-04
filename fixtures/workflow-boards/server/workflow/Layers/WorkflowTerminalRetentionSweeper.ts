import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type { BoardId, LaneKey, TicketId } from "../../../contracts/workflow.ts";
import { BoardRegistry } from "../Services/BoardRegistry.ts";
import { WorkflowAgentSessionStore } from "../Services/WorkflowAgentSessionStore.ts";
import { WorkflowBoardSaveLocks } from "../Services/WorkflowBoardSaveLocks.ts";
import { WorkflowEngine } from "../Services/WorkflowEngine.ts";
import { WorkflowEventStore } from "../Services/WorkflowEventStore.ts";
import { WorkflowReadModel } from "../Services/WorkflowReadModel.ts";
import {
  WorkflowTerminalRetentionSweeper,
  type WorkflowTerminalRetentionSweepResult,
  type WorkflowTerminalRetentionSweeperShape,
} from "../Services/WorkflowTerminalRetentionSweeper.ts";
import { WorkflowThreadJanitor } from "../Services/WorkflowThreadJanitor.ts";
import { WorkflowWorktreeJanitor } from "../Services/WorkflowWorktreeJanitor.ts";
import { deleteWorkflowBoardTicketOwnedStateWhen } from "../boardDeletion.ts";

const DEFAULT_SWEEP_INTERVAL_MS = 15 * 60 * 1000;
const DEFAULT_MAX_DELETES_PER_SWEEP = 100;
const isSettledTerminalTicketStatus = (status: string) =>
  status === "idle" || status === "done" || status === "failed";

export interface WorkflowTerminalRetentionSweeperLiveOptions {
  readonly sweepIntervalMs?: number;
  readonly maxDeletesPerSweep?: number;
  readonly nowMs?: Effect.Effect<number>;
}

interface ExpiredTicketRow {
  readonly ticketId: TicketId;
  readonly terminalAt: string;
}

interface CurrentTicketRetentionRow {
  readonly currentLaneKey: LaneKey;
  readonly status: string;
  readonly terminalAt: string | null;
}

interface RetentionLaneTarget {
  readonly boardId: BoardId;
  readonly laneKey: LaneKey;
  readonly retentionMs: number;
}

const makeWorkflowTerminalRetentionSweeper = (
  options?: WorkflowTerminalRetentionSweeperLiveOptions,
) =>
  Effect.gen(function* () {
    const boardRegistry = yield* BoardRegistry;
    const engine = yield* WorkflowEngine;
    const eventStore = yield* WorkflowEventStore;
    const readModel = yield* WorkflowReadModel;
    const saveLocks = yield* WorkflowBoardSaveLocks;
    const sql = yield* SqlClient.SqlClient;
    const worktreeJanitor = Context.getOption(
      (yield* Effect.context<never>()) as Context.Context<WorkflowWorktreeJanitor>,
      WorkflowWorktreeJanitor,
    );
    const threadJanitor = Context.getOption(
      (yield* Effect.context<never>()) as Context.Context<WorkflowThreadJanitor>,
      WorkflowThreadJanitor,
    );
    const agentSessions = Context.getOption(
      (yield* Effect.context<never>()) as Context.Context<WorkflowAgentSessionStore>,
      WorkflowAgentSessionStore,
    );

    const sweepIntervalMs = Math.max(1, options?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);
    const maxDeletesPerSweep = Math.max(
      1,
      Math.floor(options?.maxDeletesPerSweep ?? DEFAULT_MAX_DELETES_PER_SWEEP),
    );
    const nowMs = options?.nowMs ?? Clock.currentTimeMillis;
    const listDefinitions = boardRegistry.listDefinitions;
    const cancelTicketPipelines = engine.cancelTicketPipelines;
    const deleteTicketState = readModel.deleteTicketState;
    let nextSweepCursorKey: string | null = null;

    const retentionTargetKey = (target: Pick<RetentionLaneTarget, "boardId" | "laneKey">) =>
      `${target.boardId as string}::${target.laneKey as string}`;

    const cursorAfter = (
      targets: ReadonlyArray<RetentionLaneTarget>,
      target: RetentionLaneTarget,
    ) => {
      if (targets.length === 0) {
        return null;
      }
      const currentIndex = targets.findIndex(
        (candidate) => retentionTargetKey(candidate) === retentionTargetKey(target),
      );
      if (currentIndex < 0) {
        return retentionTargetKey(targets[0]!);
      }
      return retentionTargetKey(targets[(currentIndex + 1) % targets.length]!);
    };

    const rotateTargets = (targets: ReadonlyArray<RetentionLaneTarget>) => {
      if (nextSweepCursorKey === null) {
        return targets;
      }
      const startIndex = targets.findIndex(
        (target) => retentionTargetKey(target) === nextSweepCursorKey,
      );
      if (startIndex <= 0) {
        return targets;
      }
      return [...targets.slice(startIndex), ...targets.slice(0, startIndex)];
    };

    const expiredTicketsForLane = (
      boardId: BoardId,
      laneKey: LaneKey,
      cutoffIso: string,
      limit: number,
    ) =>
      sql<ExpiredTicketRow>`
        SELECT
          ticket_id AS "ticketId",
          terminal_at AS "terminalAt"
        FROM p_workflow_boards_projection_ticket
        WHERE board_id = ${boardId}
          AND current_lane_key = ${laneKey}
          AND terminal_at IS NOT NULL
          AND terminal_at < ${cutoffIso}
          AND status IN ('idle', 'done', 'failed')
        ORDER BY terminal_at ASC, ticket_id ASC
        LIMIT ${limit}
      `;

    const isStillExpiredTerminalTicket = (boardId: BoardId, ticketId: TicketId) =>
      Effect.gen(function* () {
        const rows = yield* sql<CurrentTicketRetentionRow>`
          SELECT
            current_lane_key AS "currentLaneKey",
            status,
            terminal_at AS "terminalAt"
          FROM p_workflow_boards_projection_ticket
          WHERE board_id = ${boardId}
            AND ticket_id = ${ticketId}
        `;
        const ticket = rows[0];
        if (!ticket?.terminalAt) {
          return false;
        }
        if (!isSettledTerminalTicketStatus(ticket.status)) {
          return false;
        }

        const lane = yield* boardRegistry.getLane(boardId, ticket.currentLaneKey);
        if (lane?.terminal !== true || lane.retention === undefined) {
          return false;
        }

        const retentionMs = Duration.toMillis(lane.retention);
        if (retentionMs <= 0) {
          return false;
        }

        const now = yield* nowMs;
        const cutoffIso = DateTime.formatIso(DateTime.makeUnsafe(now - retentionMs));
        return ticket.terminalAt < cutoffIso;
      });

    const sweep: WorkflowTerminalRetentionSweeperShape["sweep"] = () =>
      Effect.gen(function* () {
        const boards = yield* listDefinitions();
        const retentionTargets = boards.flatMap((board) =>
          board.definition.lanes.flatMap((lane) =>
            lane.terminal !== true || lane.retention === undefined
              ? []
              : [
                  {
                    boardId: board.boardId,
                    laneKey: lane.key,
                    retentionMs: Duration.toMillis(lane.retention),
                  } satisfies RetentionLaneTarget,
                ],
          ),
        );
        const orderedRetentionTargets = rotateTargets(retentionTargets);
        const now = yield* nowMs;
        const result = {
          candidateCount: 0,
          deletedCount: 0,
          failedCount: 0,
        } satisfies WorkflowTerminalRetentionSweepResult;
        let candidateCount = result.candidateCount;
        let deletedCount = result.deletedCount;
        let failedCount = result.failedCount;
        let remainingDeleteBudget = maxDeletesPerSweep;
        let moreRemaining = false;

        const hasMoreExpiredTickets = Effect.gen(function* () {
          for (const target of retentionTargets) {
            const cutoffIso = DateTime.formatIso(DateTime.makeUnsafe(now - target.retentionMs));
            const tickets = yield* expiredTicketsForLane(
              target.boardId,
              target.laneKey,
              cutoffIso,
              1,
            ).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("workflow.terminal-retention.more-query-failed", {
                  boardId: target.boardId,
                  laneKey: target.laneKey,
                  cause,
                }).pipe(Effect.as([] as ReadonlyArray<ExpiredTicketRow>)),
              ),
            );
            if (tickets.length > 0) {
              return true;
            }
          }
          return false;
        });

        targets: for (const target of orderedRetentionTargets) {
          if (remainingDeleteBudget <= 0) {
            break;
          }

          const cutoffIso = DateTime.formatIso(DateTime.makeUnsafe(now - target.retentionMs));
          const tickets = yield* expiredTicketsForLane(
            target.boardId,
            target.laneKey,
            cutoffIso,
            remainingDeleteBudget + 1,
          ).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("workflow.terminal-retention.ticket-query-failed", {
                boardId: target.boardId,
                laneKey: target.laneKey,
                cause,
              }).pipe(Effect.as([] as ReadonlyArray<ExpiredTicketRow>)),
            ),
          );
          const ticketsToProcess = tickets.slice(0, remainingDeleteBudget);
          moreRemaining = moreRemaining || tickets.length > ticketsToProcess.length;

          for (const ticket of ticketsToProcess) {
            candidateCount += 1;
            const outcome = yield* deleteWorkflowBoardTicketOwnedStateWhen(
              {
                saveLocks,
                engine: { cancelTicketPipelines },
                eventStore,
                readModel: { deleteTicketState },
                sql,
                ...(Option.isSome(worktreeJanitor)
                  ? { worktreeJanitor: worktreeJanitor.value }
                  : {}),
                ...(Option.isSome(threadJanitor) ? { threadJanitor: threadJanitor.value } : {}),
                ...(Option.isSome(agentSessions) ? { agentSessions: agentSessions.value } : {}),
              },
              target.boardId,
              ticket.ticketId,
              isStillExpiredTerminalTicket(target.boardId, ticket.ticketId),
            ).pipe(
              Effect.tap((deleted) =>
                deleted
                  ? Effect.logInfo("workflow.terminal-retention.ticket-deleted", {
                      boardId: target.boardId,
                      laneKey: target.laneKey,
                      ticketId: ticket.ticketId,
                      terminalAt: ticket.terminalAt,
                      retentionMs: target.retentionMs,
                    })
                  : Effect.logInfo("workflow.terminal-retention.ticket-skip-stale", {
                      boardId: target.boardId,
                      laneKey: target.laneKey,
                      ticketId: ticket.ticketId,
                      terminalAt: ticket.terminalAt,
                    }),
              ),
              Effect.map((deleted): "deleted" | "skipped" => (deleted ? "deleted" : "skipped")),
              Effect.catchCause((cause) =>
                Effect.logWarning("workflow.terminal-retention.ticket-delete-failed", {
                  boardId: target.boardId,
                  laneKey: target.laneKey,
                  ticketId: ticket.ticketId,
                  cause,
                }).pipe(Effect.as("failed" as const)),
              ),
            );

            if (outcome === "deleted") {
              deletedCount += 1;
            } else if (outcome === "failed") {
              failedCount += 1;
            }
            if (outcome === "deleted" || outcome === "failed") {
              remainingDeleteBudget -= 1;
              if (remainingDeleteBudget <= 0) {
                nextSweepCursorKey = cursorAfter(retentionTargets, target);
                break targets;
              }
            }
          }
        }

        if (remainingDeleteBudget <= 0 && !moreRemaining) {
          moreRemaining = yield* hasMoreExpiredTickets;
        }

        if (candidateCount > 0 || moreRemaining) {
          yield* Effect.logInfo("workflow.terminal-retention.sweep-complete", {
            candidateCount,
            deletedCount,
            failedCount,
            maxDeletesPerSweep,
            moreRemaining,
          });
        }

        return { candidateCount, deletedCount, failedCount };
      });

    const start: WorkflowTerminalRetentionSweeperShape["start"] = () =>
      Effect.gen(function* () {
        yield* Effect.forkScoped(
          sweep().pipe(
            Effect.catchDefect((defect: unknown) =>
              Effect.logWarning("workflow.terminal-retention.sweep-defect", {
                defect,
              }),
            ),
            Effect.repeat(Schedule.spaced(Duration.millis(sweepIntervalMs))),
          ),
        );

        yield* Effect.logInfo("workflow.terminal-retention.started", {
          sweepIntervalMs,
        });
      });

    return { sweep, start } satisfies WorkflowTerminalRetentionSweeperShape;
  });

export const makeWorkflowTerminalRetentionSweeperLive = (
  options?: WorkflowTerminalRetentionSweeperLiveOptions,
) =>
  Layer.effect(
    WorkflowTerminalRetentionSweeper,
    Effect.gen(function* () {
      const service = yield* makeWorkflowTerminalRetentionSweeper(options);
      yield* service.start();
      return service;
    }),
  );

export const WorkflowTerminalRetentionSweeperLive = makeWorkflowTerminalRetentionSweeperLive();
