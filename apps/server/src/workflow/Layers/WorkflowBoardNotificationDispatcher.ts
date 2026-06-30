import type { EnvironmentId } from "@t3tools/contracts";
import type { RelayBoardTicketState } from "@t3tools/contracts/relay";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import {
  WorkflowBoardNotificationDispatcher,
  type WorkflowBoardNotificationDispatcherShape,
  type WorkflowBoardNotificationSweepResult,
} from "../Services/WorkflowBoardNotificationDispatcher.ts";
import { WorkflowBoardNotificationRelay } from "../Services/WorkflowBoardNotificationRelay.ts";
import { WorkflowReadModel } from "../Services/WorkflowReadModel.ts";
import { redactSensitiveText, truncateKeepingHead } from "../redactSensitiveText.ts";

const DEFAULT_SWEEP_INTERVAL_MS = 5_000;
const DEFAULT_MAX_PER_SWEEP = 20;
const MAX_ATTEMPTS = 5;
// Push-notification body cap. Push payloads are tiny; 240 chars is a generous
// single-screen preview that still leaves room for the truncation marker.
const MAX_NOTIFICATION_BODY = 240;
const DEFAULT_BODY = "Needs your attention";

// Statuses that mean the ticket still wants a human. Anything else (running,
// idle, done, failed, or a vanished ticket) means it self-resolved before we
// notified — supersede the row so we don't buzz.
const NEEDS_YOU_STATUSES = new Set(["waiting_on_user", "blocked"]);

const VALID_ATTENTION_KINDS = new Set<RelayBoardTicketState["attentionKind"]>([
  "waiting_for_approval",
  "waiting_for_input",
  "blocked",
]);

const normalizeAttentionKind = (raw: string | null): RelayBoardTicketState["attentionKind"] =>
  raw !== null && VALID_ATTENTION_KINDS.has(raw as RelayBoardTicketState["attentionKind"])
    ? (raw as RelayBoardTicketState["attentionKind"])
    : "waiting_for_input";

interface OutboxRow {
  readonly outboxId: string;
  readonly ticketId: string;
  readonly boardId: string;
  readonly sequence: number;
  readonly status: string;
  readonly attentionKind: string | null;
  readonly attentionReason: string | null;
  readonly attemptCount: number;
}

export interface WorkflowBoardNotificationDispatcherLiveOptions {
  readonly sweepIntervalMs?: number;
  readonly maxPerSweep?: number;
}

const makeWorkflowBoardNotificationDispatcher = (
  options?: WorkflowBoardNotificationDispatcherLiveOptions,
) =>
  Effect.gen(function* () {
    const relay = yield* WorkflowBoardNotificationRelay;
    const readModel = yield* WorkflowReadModel;
    const serverEnvironment = yield* ServerEnvironment;
    const sql = yield* SqlClient.SqlClient;

    const sweepIntervalMs = Math.max(1, options?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);
    const maxPerSweep = Math.max(1, Math.floor(options?.maxPerSweep ?? DEFAULT_MAX_PER_SWEEP));

    const buildBody = (reason: string | null): string => {
      // Keep the START of the reason for a notification preview — the meaningful
      // content (e.g. "Approve deploy to prod?") leads; trailing log noise is
      // what should be dropped on overflow.
      const redacted = truncateKeepingHead(
        redactSensitiveText(reason ?? ""),
        MAX_NOTIFICATION_BODY,
      );
      return redacted.trim().length === 0 ? DEFAULT_BODY : redacted;
    };

    const markState = (outboxId: string, deliveryState: string, attemptCount?: number) =>
      attemptCount === undefined
        ? sql`UPDATE workflow_notification_outbox SET delivery_state = ${deliveryState} WHERE outbox_id = ${outboxId}`
        : sql`UPDATE workflow_notification_outbox SET delivery_state = ${deliveryState}, attempt_count = ${attemptCount} WHERE outbox_id = ${outboxId}`;

    // Conditional re-mark for the retry path. The committer (WorkflowEventCommitter)
    // can concurrently flip this row to 'superseded' when a newer needs-you
    // transition for the same ticket commits between our SELECT and this write.
    // An unconditional `markState(..., 'pending', ...)` would resurrect a
    // superseded row and re-deliver a stale older transition on the next sweep.
    // Guarding on `delivery_state = 'pending'` makes the re-mark a no-op once the
    // row has left 'pending', preventing the lost-update. Terminal re-marks
    // ('sent'/'failed'/'superseded') don't need this guard: writing a terminal
    // state over a superseded row is harmless since neither is re-swept.
    const rescheduleRetry = (outboxId: string, attemptCount: number) =>
      sql`UPDATE workflow_notification_outbox SET delivery_state = 'pending', attempt_count = ${attemptCount} WHERE outbox_id = ${outboxId} AND delivery_state = 'pending'`;

    // Process a single row. Returns the outcome category for the sweep summary.
    // Per-row errors are caught here so one bad row can't abort the sweep.
    const processRow = (
      row: OutboxRow,
      envId: EnvironmentId,
    ): Effect.Effect<"sent" | "superseded" | "failed"> =>
      Effect.gen(function* () {
        const detail = yield* readModel.getTicketDetail(row.ticketId as never);

        // Relevance recheck: ticket self-resolved → supersede, don't buzz.
        if (detail === null || !NEEDS_YOU_STATUSES.has(detail.ticket.status)) {
          yield* markState(row.outboxId, "superseded");
          return "superseded" as const;
        }

        // The relay decodes title as TrimmedNonEmptyString; a blank/whitespace
        // ticket title would be rejected → retries → lost notification. Fall
        // back to a non-empty default.
        const safeTitle =
          detail.ticket.title.trim().length > 0
            ? detail.ticket.title
            : "Ticket needs your attention";

        const state: RelayBoardTicketState = {
          environmentId: envId,
          boardId: row.boardId,
          ticketId: row.ticketId,
          attentionKind: normalizeAttentionKind(row.attentionKind),
          title: safeTitle,
          body: buildBody(row.attentionReason),
          // Canonical push deep-link format: `/tickets/{env}/{board}/{ticket}`.
          // This is the ONLY consumer of this field — it flows relay → APNs →
          // mobile (`normalizeTicketDeepLink` in
          // apps/mobile/src/features/agent-awareness/notificationPayload.ts), which
          // rejects query-string forms (`?`/`#`). The web in-app `/{env}/board?...`
          // route is a separate concern and never reads this field. Keep this path
          // shape in sync with mobile's `encodeTicketDeepLink`.
          deepLink: `/tickets/${encodeURIComponent(envId)}/${encodeURIComponent(
            row.boardId,
          )}/${encodeURIComponent(row.ticketId)}`,
          transitionId: String(row.sequence),
        };

        const published = yield* relay
          .publishTicket({
            environmentId: envId,
            boardId: row.boardId,
            ticketId: row.ticketId,
            state,
          })
          .pipe(Effect.result);

        if (Result.isSuccess(published)) {
          yield* markState(row.outboxId, "sent");
          return "sent" as const;
        }

        const nextAttempt = row.attemptCount + 1;
        if (nextAttempt >= MAX_ATTEMPTS) {
          yield* Effect.logError("workflow.board-notification.give-up", {
            outboxId: row.outboxId,
            ticketId: row.ticketId,
            sequence: row.sequence,
            attemptCount: nextAttempt,
            error: published.failure,
          });
          yield* markState(row.outboxId, "failed", nextAttempt);
          return "failed" as const;
        }
        yield* rescheduleRetry(row.outboxId, nextAttempt);
        return "failed" as const;
      }).pipe(
        Effect.catchCause((cause) =>
          // Re-raise defects (programming bugs) so the sweep-level catchDefect
          // guard surfaces them; only swallow expected/transient failures as a
          // per-row "failed" so one bad row can't abort the whole sweep.
          // Re-dying with the squashed cause keeps the error channel `never`.
          Cause.hasDies(cause) || Cause.hasInterrupts(cause)
            ? Effect.die(Cause.squash(cause))
            : Effect.logWarning("workflow.board-notification.row-failed", {
                outboxId: row.outboxId,
                ticketId: row.ticketId,
                cause,
              }).pipe(Effect.as("failed" as const)),
        ),
      );

    const sweep: WorkflowBoardNotificationDispatcherShape["sweep"] = () =>
      Effect.gen(function* () {
        const rows = yield* sql<OutboxRow>`
          SELECT
            outbox_id AS "outboxId",
            ticket_id AS "ticketId",
            board_id AS "boardId",
            sequence,
            status,
            attention_kind AS "attentionKind",
            attention_reason AS "attentionReason",
            attempt_count AS "attemptCount"
          FROM workflow_notification_outbox
          WHERE delivery_state = 'pending'
          ORDER BY created_at ASC
          LIMIT ${maxPerSweep}
        `.pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("workflow.board-notification.select-failed", { cause }).pipe(
              Effect.as([] as ReadonlyArray<OutboxRow>),
            ),
          ),
        );

        let claimed = 0;
        let sent = 0;
        let superseded = 0;
        let failed = 0;

        if (rows.length === 0) {
          return { claimed, sent, superseded, failed };
        }

        // Resolve the environment id once per sweep.
        const envId = yield* serverEnvironment.getEnvironmentId;

        for (const row of rows) {
          claimed += 1;
          const outcome = yield* processRow(row, envId);
          if (outcome === "sent") sent += 1;
          else if (outcome === "superseded") superseded += 1;
          else if (outcome === "failed") failed += 1;
        }

        if (claimed > 0) {
          yield* Effect.logInfo("workflow.board-notification.sweep-complete", {
            claimed,
            sent,
            superseded,
            failed,
          });
        }

        return { claimed, sent, superseded, failed } satisfies WorkflowBoardNotificationSweepResult;
      });

    const start: WorkflowBoardNotificationDispatcherShape["start"] = () =>
      Effect.gen(function* () {
        yield* Effect.forkScoped(
          sweep().pipe(
            Effect.catchDefect((defect: unknown) =>
              Effect.logWarning("workflow.board-notification.sweep-defect", { defect }),
            ),
            Effect.repeat(Schedule.spaced(Duration.millis(sweepIntervalMs))),
          ),
        );

        yield* Effect.logInfo("workflow.board-notification.started", { sweepIntervalMs });
      });

    return { sweep, start } satisfies WorkflowBoardNotificationDispatcherShape;
  });

export const makeWorkflowBoardNotificationDispatcherLive = (
  options?: WorkflowBoardNotificationDispatcherLiveOptions,
) =>
  Layer.effect(
    WorkflowBoardNotificationDispatcher,
    makeWorkflowBoardNotificationDispatcher(options),
  );

export const WorkflowBoardNotificationDispatcherLive =
  makeWorkflowBoardNotificationDispatcherLive();
