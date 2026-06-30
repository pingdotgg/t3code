import type { BoardId, TicketId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { WorkflowEventStoreErrorCode } from "../Services/Errors.ts";
import { GitHubPort, type GitHubPrDetail } from "../Services/GitHubPort.ts";
import { WorkflowBoardSaveLocks } from "../Services/WorkflowBoardSaveLocks.ts";
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

// JSON encode/decode via Schema (the codebase convention for persisted JSON —
// see WorkflowProjectionPipeline). Payloads are already sanitized + bounded.
const encodePayloadJson = Schema.encodeUnknownEffect(Schema.UnknownFromJsonString);
const decodePayloadJson = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString);

// A watched ticket: an open PR whose projection row is still non-terminal.
interface WatchedTicketRow {
  readonly ticketId: TicketId;
  readonly boardId: BoardId;
  readonly repoRoot: string | null;
  readonly prNumber: number;
  readonly repo: string;
  readonly lastHeadSha: string | null;
  readonly lastCiState: string | null;
  readonly lastReviewDecision: string | null;
  readonly lastCommentCursor: string | null;
}

// One durable outbox record produced by observing a single PR transition.
interface PendingObservation {
  readonly observationId: string;
  readonly ticketId: TicketId;
  readonly dedupKey: string;
  readonly eventName: string;
  readonly payloadJson: string;
  readonly messageBody: string | null;
}

// The new `last_*` snapshot to persist for a ticket after observing it.
interface ObservedState {
  readonly headSha: string | null;
  readonly ciState: string | null;
  readonly reviewDecision: string;
  readonly commentCursor: string | null;
  readonly prState: "open" | "merged" | "closed";
}

// A phase-2 work item: a pending observation joined to its board.
interface PendingPhase2Row {
  readonly observationId: string;
  readonly ticketId: TicketId;
  readonly boardId: BoardId;
  readonly eventName: string;
  readonly payloadJson: string;
  readonly messageBody: string | null;
  readonly attemptCount: number;
}

// A pending observation whose ingest keeps failing with a non-terminal,
// non-transient error (e.g. a predicate-eval error) would otherwise be retried
// every sweep forever. After this many failed attempts we give up and mark it
// 'failed' so it stops being drained.
const MAX_INGEST_ATTEMPTS = 5;

const redactAndCap = (text: string): string =>
  truncateKeepingTail(redactSensitiveText(text), MAX_TICKET_MESSAGE_BODY_LENGTH);

const makeWorkflowGitHubPoller = (options?: WorkflowGitHubPollerLiveOptions) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const saveLocks = yield* WorkflowBoardSaveLocks;
    const engine = yield* WorkflowEngine;
    const gitHub = yield* GitHubPort;

    const sweepIntervalMs = Math.max(1, options?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);
    const maxTicketsPerSweep = Math.max(
      1,
      Math.floor(options?.maxTicketsPerSweep ?? DEFAULT_MAX_TICKETS_PER_SWEEP),
    );

    // Round-robin cursor over watched tickets (same mechanic as the retention
    // sweeper's lane cursor): we remember the ticket to *start* from next sweep
    // so a cap'd sweep eventually covers every watched ticket.
    let nextSweepCursorTicketId: string | null = null;

    // observation_id is an internal opaque PK — a v4 UUID is fine and avoids
    // pulling the Crypto service into this layer (which the engine test harness
    // does not provide).
    const newObservationId = Effect.sync(
      // @effect-diagnostics-next-line cryptoRandomUUIDInEffect:off
      () => globalThis.crypto.randomUUID() as string,
    );

    const watchedTickets = () =>
      sql<WatchedTicketRow>`
        SELECT
          pr.ticket_id AS "ticketId",
          ticket.board_id AS "boardId",
          (
            SELECT projects.workspace_root
            FROM projection_board AS board
            INNER JOIN projection_projects AS projects
              ON projects.project_id = board.project_id
            WHERE board.board_id = ticket.board_id
          ) AS "repoRoot",
          pr.pr_number AS "prNumber",
          pr.repo,
          pr.last_head_sha AS "lastHeadSha",
          pr.last_ci_state AS "lastCiState",
          pr.last_review_decision AS "lastReviewDecision",
          pr.last_comment_cursor AS "lastCommentCursor"
        FROM workflow_pr_state AS pr
        INNER JOIN projection_ticket AS ticket
          ON ticket.ticket_id = pr.ticket_id
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
        // The cursor ticket is no longer watched (merged/closed). Resume at the
        // next ticket past it in id order rather than resetting to the head, so
        // the tail of the list isn't starved on every churn. rows are ORDER BY
        // ticket_id ASC, so the first id greater than the cursor is the resume
        // point; if the cursor is past the end, wrap to the head.
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

    // Phase 1: build the durable observation records + the new last_* snapshot
    // for one ticket by diffing live PR detail against the stored row. Pure
    // computation + (for ci.failed / changes_requested) read-only gh fetches;
    // NO database writes and NO engine/committer calls.
    const observeTicket = (ticket: WatchedTicketRow) =>
      Effect.gen(function* () {
        const cwd = ticket.repoRoot ?? ".";
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

        // A new head sha resets the CI comparison: each push earns its own CI
        // verdict and the dedup_key embeds the sha so per-push events stay
        // distinct. When the sha changed, treat lastCiState as unknown.
        const shaChanged = detail.headSha !== null && detail.headSha !== ticket.lastHeadSha;
        const ciBaseline = shaChanged ? null : ticket.lastCiState;

        // dedup_key is a TABLE-WIDE UNIQUE constraint, so every key is scoped by
        // ticketId — otherwise two tickets sharing a head sha (monorepo) or both
        // reaching merged would collide and the second observation would be
        // silently dropped by INSERT OR IGNORE.
        const tid = ticket.ticketId as string;

        // --- CI transitions (keyed by head sha) ---
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

        // --- Review decision transitions ---
        let nextCommentCursor = ticket.lastCommentCursor;
        const reviewDecisionChanged = detail.reviewDecision !== ticket.lastReviewDecision;
        // Sync feedback whenever the PR CURRENTLY has changes requested — not only
        // on the first transition. A reviewer can request changes across multiple
        // rounds without GitHub's aggregate reviewDecision flipping (it stays
        // CHANGES_REQUESTED), so gating on the transition alone silently drops
        // every round after the first. Per-comment dedup (comment:<tid>:<id>) and
        // the head-sha/newest-id routing key keep re-polls idempotent.
        if (detail.reviewDecision === "changes_requested") {
          const feedback = yield* gitHub
            .listReviewFeedback({
              cwd,
              prNumber: ticket.prNumber,
              repo: ticket.repo,
            })
            .pipe(Effect.orElseSucceed(() => []));
          const cursor = ticket.lastCommentCursor;
          // Inclusive lower bound (>=) so an item whose timestamp exactly equals
          // the stored cursor is never permanently skipped (two items can share a
          // timestamp); per-comment dedup prevents re-recording ones already seen.
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
          // Routing event (no body). Keyed by head sha AND the newest feedback id
          // so a new push re-fires (head sha changes), a new comment on the same
          // head re-fires (newest id changes), and a quiet re-poll is deduped.
          const newestId = fresh.length > 0 ? fresh[fresh.length - 1]!.id : null;
          if (reviewDecisionChanged || newestId !== null) {
            yield* push({
              dedupKey: `review:${tid}:${detail.headSha ?? "nohead"}:changes_requested:${newestId ?? "init"}`,
              eventName: "pr.changes_requested",
              payload: {},
              messageBody: null,
            });
          }
          // Advance the cursor to the newest feedback item observed.
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

        // --- Lifecycle transitions ---
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
          // When the sha changed and no new CI verdict is in yet, record the
          // live verdict (pending) so a later transition still diffs cleanly.
          ciState: detail.ciState,
          reviewDecision: detail.reviewDecision,
          commentCursor: nextCommentCursor,
          prState: detail.state,
        };

        return { observations, observed };
      });

    // Phase 1 write: under the save lock + a transaction, recheck the PR is
    // still watched, INSERT OR IGNORE the observations, advance last_*.
    // PLAIN SQL ONLY — never engine.* / committer.* here (they self-acquire the
    // same non-reentrant save lock → deadlock).
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
              FROM workflow_pr_state
              WHERE ticket_id = ${ticket.ticketId}
            `;
            const current = rows[0];
            // Gone (ticket deleted between observe and now) or already terminal
            // → skip every write.
            if (current === undefined || current.prState !== "open") {
              return 0;
            }
            const ticketExists = yield* sql<{ readonly one: number }>`
              SELECT 1 AS "one"
              FROM projection_ticket
              WHERE ticket_id = ${ticket.ticketId}
            `;
            if (ticketExists[0] === undefined) {
              return 0;
            }

            const createdAt = yield* nowIso;
            let recorded = 0;
            for (const observation of observations) {
              // Count only the rows that are genuinely new: a UNIQUE dedup_key
              // collision means this transition was already recorded (a
              // re-observation no-op). Checking before the INSERT OR IGNORE
              // gives an accurate `recorded` count without relying on a
              // driver-specific affected-rows shape.
              const existing = yield* sql<{ readonly one: number }>`
                SELECT 1 AS "one"
                FROM workflow_pr_observation
                WHERE dedup_key = ${observation.dedupKey}
              `;
              if (existing[0] !== undefined) {
                continue;
              }
              yield* sql`
                INSERT OR IGNORE INTO workflow_pr_observation (
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
              UPDATE workflow_pr_state
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

    // Phase 2: drain pending observations across ALL still-reachable boards
    // (joined to projection_ticket for boardId), oldest first. NO save lock is
    // held here — engine.* self-acquire it. An observation whose PR has since
    // merged is still drained because we select by status, not pr_state.
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
          FROM workflow_pr_observation AS obs
          INNER JOIN projection_ticket AS ticket
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

    // Apply one pending observation: post its message (if any), then ingest the
    // external event. Both a successful outcome AND a "ticket not found on this
    // board" error are terminal (the ticket/board is gone or moved — re-ingest
    // would never help) → mark 'applied'. Any OTHER ingest error increments
    // attempt_count and leaves the row 'pending'; once attempt_count would
    // reach MAX_INGEST_ATTEMPTS the row is given up on (status 'failed') so a
    // poison pill stops being retried every sweep. Returns the row's resulting
    // state this pass: "applied" (ingested), "failed" (given up), or "pending"
    // (will retry next sweep).
    // A non-terminal phase-2 failure (a message post OR an ingest that is not a
    // terminal "ticket not found"): count the attempt and leave the row
    // 'pending', or give up at the ceiling by marking it 'failed' so a poison
    // pill — whether the poison is the post or the ingest — stops being retried
    // every sweep. Returns "failed" (given up) or "pending" (will retry).
    const recordPhase2Failure = (row: PendingPhase2Row, stage: "post" | "ingest") =>
      Effect.gen(function* () {
        const nextAttempt = row.attemptCount + 1;
        if (nextAttempt >= MAX_INGEST_ATTEMPTS) {
          yield* sql`
            UPDATE workflow_pr_observation
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
          UPDATE workflow_pr_observation
          SET attempt_count = ${nextAttempt}
          WHERE observation_id = ${row.observationId}
        `;
        return "pending" as const;
      });

    const applyPendingObservation = (row: PendingPhase2Row) =>
      Effect.gen(function* () {
        if (row.messageBody !== null) {
          // A persistently-failing post must not retry forever — treat ANY post
          // error as a non-terminal phase-2 failure that counts toward the
          // ceiling (rather than throwing out to the sweep-level catch, which
          // left the row 'pending' without incrementing attempt_count).
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
          // Posted-marker: clearing message_body makes a re-drive (crash before
          // the 'applied' mark, or a later ingest give-up pass) skip the post.
          // The tiny window between post and marker is an accepted
          // at-least-once double-post.
          yield* sql`
            UPDATE workflow_pr_observation
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
              // Terminal condition (ticket no longer on this board) → give up and
              // mark applied; anything else is retryable. Match the typed code
              // rather than the message text so a message reword can't silently
              // turn this into a retry-forever.
              error.code === WorkflowEventStoreErrorCode.ticketNotOnBoard
                ? Effect.succeed("applied" as const)
                : Effect.succeed("error" as const),
            ),
          );

        if (ingestOutcome === "applied") {
          yield* sql`
            UPDATE workflow_pr_observation
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

        // Advance the round-robin cursor to the first ticket we did NOT process
        // this sweep, so the next sweep starts there.
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

        // Phase 2 runs regardless: it also drains leftover pending rows from a
        // prior crashed process (the watched set is unrelated to which rows are
        // pending).
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
  Layer.effect(WorkflowGitHubPoller, makeWorkflowGitHubPoller(options));

export const WorkflowGitHubPollerLive = makeWorkflowGitHubPollerLive();
