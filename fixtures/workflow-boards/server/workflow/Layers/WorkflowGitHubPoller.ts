import { ProjectId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type { BoardId, TicketId } from "../../../contracts/workflow.ts";
import { WorkflowEventStoreErrorCode, WorkflowEventStoreError } from "../Services/Errors.ts";
import { GitHubPort, type GitHubPrDetail } from "../Services/GitHubPort.ts";
import { WorkflowBoardSaveLocks } from "../Services/WorkflowBoardSaveLocks.ts";
import { WorkflowEnvironmentsReadCapability } from "../Services/WorkflowCapabilities.ts";
import { WorkflowEngine } from "../Services/WorkflowEngine.ts";
import {
  WorkflowGitHubPoller,
  type WorkflowGitHubPollerShape,
  type WorkflowGitHubPollerSweepResult,
} from "../Services/WorkflowGitHubPoller.ts";
import { sanitizeExternalEventPayload } from "../externalEvent.ts";
import { redactSensitiveText, truncateKeepingTail } from "../redactSensitiveText.ts";
import { MAX_TICKET_MESSAGE_BODY_LENGTH } from "../ticketMessageBody.ts";

const DEFAULT_SWEEP_INTERVAL_MS = 45_000;
const DEFAULT_MAX_TICKETS_PER_SWEEP = 20;

export interface WorkflowGitHubPollerLiveOptions {
  readonly sweepIntervalMs?: number;
  readonly maxTicketsPerSweep?: number;
}

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
const encodePayloadJson = Schema.encodeUnknownEffect(Schema.UnknownFromJsonString);
const decodePayloadJson = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString);

interface WatchedTicketRow {
  readonly ticketId: TicketId;
  readonly boardId: BoardId;
  readonly projectId: string | null;
  readonly prNumber: number;
  readonly repo: string;
  readonly lastHeadSha: string | null;
  readonly lastCiState: string | null;
  readonly lastReviewDecision: string | null;
  readonly lastCommentCursor: string | null;
}

interface PendingObservation {
  readonly observationId: string;
  readonly ticketId: TicketId;
  readonly dedupKey: string;
  readonly eventName: string;
  readonly payloadJson: string;
  readonly messageBody: string | null;
}

interface ObservedState {
  readonly headSha: string | null;
  readonly ciState: string | null;
  readonly reviewDecision: string;
  readonly commentCursor: string | null;
  readonly prState: "open" | "merged" | "closed";
}

interface PendingPhase2Row {
  readonly observationId: string;
  readonly ticketId: TicketId;
  readonly boardId: BoardId;
  readonly eventName: string;
  readonly payloadJson: string;
  readonly messageBody: string | null;
  readonly attemptCount: number;
}

const MAX_INGEST_ATTEMPTS = 5;

const redactAndCap = (text: string): string =>
  truncateKeepingTail(redactSensitiveText(text), MAX_TICKET_MESSAGE_BODY_LENGTH);

const makeWorkflowGitHubPoller = (options?: WorkflowGitHubPollerLiveOptions) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const saveLocks = yield* WorkflowBoardSaveLocks;
    const engine = yield* WorkflowEngine;
    const gitHub = yield* GitHubPort;
    const environments = yield* WorkflowEnvironmentsReadCapability;

    const sweepIntervalMs = Math.max(1, options?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);
    const maxTicketsPerSweep = Math.max(
      1,
      Math.floor(options?.maxTicketsPerSweep ?? DEFAULT_MAX_TICKETS_PER_SWEEP),
    );

    let nextSweepCursorTicketId: string | null = null;

    const newObservationId = Effect.sync(
      // @effect-diagnostics-next-line cryptoRandomUUIDInEffect:off
      () => globalThis.crypto.randomUUID() as string,
    );

    const repoRootForTicket = (ticket: WatchedTicketRow) =>
      Effect.gen(function* () {
        if (ticket.projectId === null) {
          return yield* new WorkflowEventStoreError({
            message: `project id not found for watched ticket ${ticket.ticketId}`,
          });
        }
        const project = yield* environments.getProjectById(ProjectId.make(ticket.projectId)).pipe(
          Effect.mapError(
            (cause) =>
              new WorkflowEventStoreError({
                message: "github poller project lookup failed",
                cause,
              }),
          ),
        );
        if (project === null) {
          return yield* new WorkflowEventStoreError({
            message: `project not found for watched ticket ${ticket.ticketId}`,
          });
        }
        return project.workspaceRoot;
      });

    const watchedTickets = () =>
      sql<WatchedTicketRow>`
        SELECT
          pr.ticket_id AS "ticketId",
          ticket.board_id AS "boardId",
          board.project_id AS "projectId",
          pr.pr_number AS "prNumber",
          pr.repo,
          pr.last_head_sha AS "lastHeadSha",
          pr.last_ci_state AS "lastCiState",
          pr.last_review_decision AS "lastReviewDecision",
          pr.last_comment_cursor AS "lastCommentCursor"
        FROM p_workflow_boards_pr_state AS pr
        INNER JOIN p_workflow_boards_projection_ticket AS ticket
          ON ticket.ticket_id = pr.ticket_id
        INNER JOIN p_workflow_boards_projection_board AS board
          ON board.board_id = ticket.board_id
        WHERE pr.pr_state = 'open'
          AND ticket.terminal_at IS NULL
        ORDER BY pr.ticket_id ASC
      `;

    const rotateTickets = (rows: ReadonlyArray<WatchedTicketRow>) => {
      const cursor = nextSweepCursorTicketId;
      if (cursor === null) {
        return rows;
      }
      let startIndex = rows.findIndex((row) => (row.ticketId as string) === cursor);
      if (startIndex === -1) {
        startIndex = rows.findIndex((row) => (row.ticketId as string) > cursor);
        if (startIndex === -1) {
          return rows;
        }
      }
      if (startIndex <= 0) {
        return rows;
      }
      return [...rows.slice(startIndex), ...rows.slice(0, startIndex)];
    };

    const observeTicket = (ticket: WatchedTicketRow) =>
      Effect.gen(function* () {
        const cwd = yield* repoRootForTicket(ticket);
        const detail: GitHubPrDetail = yield* gitHub.prDetail({
          cwd,
          prNumber: ticket.prNumber,
        });

        const observations: PendingObservation[] = [];

        const push = (record: {
          readonly dedupKey: string;
          readonly eventName: string;
          readonly payload: unknown;
          readonly messageBody: string | null;
        }) =>
          Effect.gen(function* () {
            const payloadJson = yield* encodePayloadJson(
              sanitizeExternalEventPayload(record.payload),
            ).pipe(Effect.orDie);
            observations.push({
              observationId: yield* newObservationId,
              ticketId: ticket.ticketId,
              dedupKey: record.dedupKey,
              eventName: record.eventName,
              payloadJson,
              messageBody: record.messageBody,
            });
          });

        const shaChanged = detail.headSha !== null && detail.headSha !== ticket.lastHeadSha;
        const ciBaseline = shaChanged ? null : ticket.lastCiState;
        const tid = ticket.ticketId as string;

        if (detail.headSha !== null && detail.ciState !== ciBaseline) {
          if (detail.ciState === "success") {
            yield* push({
              dedupKey: `ci:${tid}:${detail.headSha}:success`,
              eventName: "ci.passed",
              payload: { sha: detail.headSha },
              messageBody: null,
            });
          } else if (detail.ciState === "failure") {
            const rawLogs = yield* gitHub
              .failingCheckLogs({ cwd, prNumber: ticket.prNumber })
              .pipe(Effect.orElseSucceed(() => null));
            const summary = rawLogs === null ? null : redactAndCap(rawLogs);
            yield* push({
              dedupKey: `ci:${tid}:${detail.headSha}:failure`,
              eventName: "ci.failed",
              payload: {
                sha: detail.headSha,
                ...(summary === null ? {} : { summary }),
              },
              messageBody: summary,
            });
          }
        }

        let nextCommentCursor = ticket.lastCommentCursor;
        const reviewDecisionChanged = detail.reviewDecision !== ticket.lastReviewDecision;
        if (detail.reviewDecision === "changes_requested") {
          const feedback = yield* gitHub
            .listReviewFeedback({
              cwd,
              prNumber: ticket.prNumber,
              repo: ticket.repo,
            })
            .pipe(Effect.orElseSucceed(() => []));
          const cursor = ticket.lastCommentCursor;
          const fresh = feedback
            .filter((item) => cursor === null || item.submittedAt >= cursor)
            .sort((a, b) =>
              a.submittedAt === b.submittedAt
                ? a.id < b.id
                  ? -1
                  : a.id > b.id
                    ? 1
                    : 0
                : a.submittedAt < b.submittedAt
                  ? -1
                  : 1,
            );
          for (const item of fresh) {
            const body = redactAndCap(
              `**@${item.author}** on PR #${ticket.prNumber}:\n${item.body}`,
            );
            yield* push({
              dedupKey: `comment:${tid}:${item.id}`,
              eventName: "pr.changes_requested",
              payload: {},
              messageBody: body,
            });
          }
          const newestId = fresh.length > 0 ? fresh[fresh.length - 1]!.id : null;
          if (reviewDecisionChanged || newestId !== null) {
            yield* push({
              dedupKey: `review:${tid}:${detail.headSha ?? "nohead"}:changes_requested:${newestId ?? "init"}`,
              eventName: "pr.changes_requested",
              payload: {},
              messageBody: null,
            });
          }
          for (const item of fresh) {
            if (nextCommentCursor === null || item.submittedAt > nextCommentCursor) {
              nextCommentCursor = item.submittedAt;
            }
          }
        } else if (reviewDecisionChanged && detail.reviewDecision === "approved") {
          yield* push({
            dedupKey: `review:${tid}:${detail.headSha ?? "nohead"}:approved`,
            eventName: "pr.approved",
            payload: {},
            messageBody: null,
          });
        }

        if (detail.state === "merged") {
          yield* push({
            dedupKey: `lifecycle:${tid}:merged`,
            eventName: "pr.merged",
            payload: {},
            messageBody: null,
          });
        } else if (detail.state === "closed") {
          yield* push({
            dedupKey: `lifecycle:${tid}:closed`,
            eventName: "pr.closed",
            payload: {},
            messageBody: null,
          });
        }

        const observed: ObservedState = {
          headSha: detail.headSha,
          ciState: detail.ciState,
          reviewDecision: detail.reviewDecision,
          commentCursor: nextCommentCursor,
          prState: detail.state,
        };

        return { observations, observed };
      });

    const persistObservations = (
      ticket: WatchedTicketRow,
      observations: ReadonlyArray<PendingObservation>,
      observed: ObservedState,
    ) =>
      saveLocks.withSaveLock(
        ticket.boardId,
        sql.withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql<{ readonly prState: string }>`
              SELECT pr_state AS "prState"
              FROM p_workflow_boards_pr_state
              WHERE ticket_id = ${ticket.ticketId}
            `;
            const current = rows[0];
            if (current === undefined || current.prState !== "open") {
              return 0;
            }
            const ticketExists = yield* sql<{ readonly one: number }>`
              SELECT 1 AS "one"
              FROM p_workflow_boards_projection_ticket
              WHERE ticket_id = ${ticket.ticketId}
            `;
            if (ticketExists[0] === undefined) {
              return 0;
            }

            const createdAt = yield* nowIso;
            let recorded = 0;
            for (const observation of observations) {
              const existing = yield* sql<{ readonly one: number }>`
                SELECT 1 AS "one"
                FROM p_workflow_boards_pr_observation
                WHERE dedup_key = ${observation.dedupKey}
              `;
              if (existing[0] !== undefined) {
                continue;
              }
              yield* sql`
                INSERT OR IGNORE INTO p_workflow_boards_pr_observation (
                  observation_id,
                  ticket_id,
                  dedup_key,
                  event_name,
                  payload_json,
                  message_body,
                  status,
                  created_at
                ) VALUES (
                  ${observation.observationId},
                  ${observation.ticketId},
                  ${observation.dedupKey},
                  ${observation.eventName},
                  ${observation.payloadJson},
                  ${observation.messageBody},
                  'pending',
                  ${createdAt}
                )
              `;
              recorded += 1;
            }

            yield* sql`
              UPDATE p_workflow_boards_pr_state
              SET last_head_sha = ${observed.headSha},
                  last_ci_state = ${observed.ciState},
                  last_review_decision = ${observed.reviewDecision},
                  last_comment_cursor = ${observed.commentCursor},
                  pr_state = ${observed.prState},
                  updated_at = ${createdAt}
              WHERE ticket_id = ${ticket.ticketId}
            `;

            return recorded;
          }),
        ),
      );

    const drainPendingObservations = () =>
      Effect.gen(function* () {
        const pending = yield* sql<PendingPhase2Row>`
          SELECT
            obs.observation_id AS "observationId",
            obs.ticket_id AS "ticketId",
            ticket.board_id AS "boardId",
            obs.event_name AS "eventName",
            obs.payload_json AS "payloadJson",
            obs.message_body AS "messageBody",
            obs.attempt_count AS "attemptCount"
          FROM p_workflow_boards_pr_observation AS obs
          INNER JOIN p_workflow_boards_projection_ticket AS ticket
            ON ticket.ticket_id = obs.ticket_id
          WHERE obs.status = 'pending'
          ORDER BY obs.created_at ASC, obs.observation_id ASC
        `;

        let applied = 0;
        for (const row of pending) {
          const outcome = yield* applyPendingObservation(row).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("workflow.github-poller.apply-failed", {
                observationId: row.observationId,
                ticketId: row.ticketId,
                eventName: row.eventName,
                cause,
              }).pipe(Effect.as("pending" as const)),
            ),
          );
          if (outcome === "applied") {
            applied += 1;
          }
        }
        return applied;
      });

    const recordPhase2Failure = (row: PendingPhase2Row, stage: "post" | "ingest") =>
      Effect.gen(function* () {
        const nextAttempt = row.attemptCount + 1;
        if (nextAttempt >= MAX_INGEST_ATTEMPTS) {
          yield* sql`
            UPDATE p_workflow_boards_pr_observation
            SET status = 'failed',
                attempt_count = ${nextAttempt}
            WHERE observation_id = ${row.observationId}
          `;
          yield* Effect.logError("workflow.github-poller.observation-given-up", {
            observationId: row.observationId,
            ticketId: row.ticketId,
            eventName: row.eventName,
            stage,
            attemptCount: nextAttempt,
          });
          return "failed" as const;
        }
        yield* sql`
          UPDATE p_workflow_boards_pr_observation
          SET attempt_count = ${nextAttempt}
          WHERE observation_id = ${row.observationId}
        `;
        return "pending" as const;
      });

    const applyPendingObservation = (row: PendingPhase2Row) =>
      Effect.gen(function* () {
        if (row.messageBody !== null) {
          const posted = yield* engine
            .postTicketMessage({
              ticketId: row.ticketId,
              text: row.messageBody,
            })
            .pipe(
              Effect.as(true as const),
              Effect.orElseSucceed(() => false as const),
            );
          if (!posted) {
            return yield* recordPhase2Failure(row, "post");
          }
          yield* sql`
            UPDATE p_workflow_boards_pr_observation
            SET message_body = NULL
            WHERE observation_id = ${row.observationId}
          `;
        }

        const payload = yield* decodePayloadJson(row.payloadJson).pipe(
          Effect.orElseSucceed(() => null as unknown),
        );
        const ingestOutcome = yield* engine
          .ingestExternalEvent({
            boardId: row.boardId,
            name: row.eventName,
            ticketId: row.ticketId,
            payload,
          })
          .pipe(
            Effect.as("applied" as const),
            Effect.catch((error) =>
              error.code === WorkflowEventStoreErrorCode.ticketNotOnBoard
                ? Effect.succeed("applied" as const)
                : Effect.succeed("error" as const),
            ),
          );

        if (ingestOutcome === "applied") {
          yield* sql`
            UPDATE p_workflow_boards_pr_observation
            SET status = 'applied'
            WHERE observation_id = ${row.observationId}
          `;
          return "applied";
        }

        return yield* recordPhase2Failure(row, "ingest");
      });

    const sweep: WorkflowGitHubPollerShape["sweep"] = () =>
      Effect.gen(function* () {
        const allWatched = yield* watchedTickets().pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("workflow.github-poller.watch-query-failed", {
              cause,
            }).pipe(Effect.as([] as ReadonlyArray<WatchedTicketRow>)),
          ),
        );
        const ordered = rotateTickets(allWatched);
        const toProcess = ordered.slice(0, maxTicketsPerSweep);

        if (ordered.length > toProcess.length) {
          nextSweepCursorTicketId = ordered[toProcess.length]!.ticketId as string;
        } else {
          nextSweepCursorTicketId = null;
        }

        let observedTickets = 0;
        let recordedObservations = 0;
        let failedTickets = 0;

        for (const ticket of toProcess) {
          observedTickets += 1;
          const outcome = yield* observeTicket(ticket).pipe(
            Effect.flatMap(({ observations, observed }) =>
              persistObservations(ticket, observations, observed),
            ),
            Effect.catchCause((cause) =>
              Effect.logWarning("workflow.github-poller.observe-failed", {
                ticketId: ticket.ticketId,
                prNumber: ticket.prNumber,
                cause,
              }).pipe(Effect.as(null)),
            ),
          );
          if (outcome === null) {
            failedTickets += 1;
          } else {
            recordedObservations += outcome;
          }
        }

        const appliedObservations = yield* drainPendingObservations().pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("workflow.github-poller.drain-failed", {
              cause,
            }).pipe(Effect.as(0)),
          ),
        );

        if (recordedObservations > 0 || appliedObservations > 0 || failedTickets > 0) {
          yield* Effect.logInfo("workflow.github-poller.sweep-complete", {
            observedTickets,
            recordedObservations,
            appliedObservations,
            failedTickets,
          });
        }

        return {
          observedTickets,
          recordedObservations,
          appliedObservations,
          failedTickets,
        } satisfies WorkflowGitHubPollerSweepResult;
      });

    const start: WorkflowGitHubPollerShape["start"] = () =>
      Effect.gen(function* () {
        yield* Effect.forkScoped(
          sweep().pipe(
            Effect.catchDefect((defect: unknown) =>
              Effect.logWarning("workflow.github-poller.sweep-defect", { defect }),
            ),
            Effect.repeat(Schedule.spaced(Duration.millis(sweepIntervalMs))),
          ),
        );
        yield* Effect.logInfo("workflow.github-poller.started", { sweepIntervalMs });
      });

    return { sweep, start } satisfies WorkflowGitHubPollerShape;
  });

export const makeWorkflowGitHubPollerLive = (options?: WorkflowGitHubPollerLiveOptions) =>
  Layer.effect(
    WorkflowGitHubPoller,
    Effect.gen(function* () {
      const service = yield* makeWorkflowGitHubPoller(options);
      return service;
    }),
  );

export const WorkflowGitHubPollerLive = makeWorkflowGitHubPollerLive();
