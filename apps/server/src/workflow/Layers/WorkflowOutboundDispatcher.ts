/**
 * WorkflowOutboundDispatcher (Live) — recovery-gated fiber that drains durable
 * `workflow_outbound_delivery` rows and POSTs each rendered payload to its
 * connection's target URL.
 *
 * Mirrors the shipped WorkflowBoardNotificationDispatcher: same `{ sweep, start }`
 * shape, the same `forkScoped` + catch-defect + `Schedule.spaced` start(), and
 * the same per-row defect-handling idiom (re-raise dies/interrupts, swallow
 * expected/transient failures as a recorded backoff so one bad row can never
 * abort the sweep). Backoff mirrors WorkflowSourceSyncer.recordFailure:
 * Retry-After on 429, else exponential `min(cap, base * 2^priorFailures)`.
 *
 * The network POST is strictly outside any transaction. The committer (Task 10)
 * already wrote these rows durably in the commit tx; this dispatcher only reads
 * them, POSTs, and records the outcome.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { OutboundEventContext, type OutboundFormatter } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { HttpClient, HttpClientError, HttpClientRequest } from "effect/unstable/http";

import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import { WorkflowOutboundConnectionStore } from "../Services/WorkflowOutboundConnectionStore.ts";
import {
  WorkflowOutboundDispatcher,
  type WorkflowOutboundDispatcherShape,
} from "../Services/WorkflowOutboundDispatcher.ts";
import { OutboundUrlValidator } from "../outbound/OutboundUrlValidator.ts";
import { renderOutbound } from "../outbound/outboundFormatters.ts";

// Mirror the notification dispatcher / source-syncer values — do not invent new
// ones. MAX_ATTEMPTS=5 (notification dispatcher); BACKOFF base/cap from the
// source syncer; a 5s sweep cadence like the notification dispatcher.
const DEFAULT_SWEEP_INTERVAL_MS = 5_000;
const DEFAULT_DRAIN_LIMIT = 20;
const MAX_ATTEMPTS = 5;
const BACKOFF_BASE_MS = 30_000; // 30s
const BACKOFF_CAP_MS = 3_600_000; // 1h
// Per-POST wall-clock cap. With concurrency:1 one hung target would otherwise
// freeze the whole sweep fiber (and Schedule.spaced cannot tick until sweep
// returns), so a timeout routes through the retryable backoff branch.
const HTTP_TIMEOUT_MS = 10_000; // 10s

// Formatters this dispatcher knows how to render. renderOutbound silently
// falls back to "generic" for anything else, so we gate on this set first and
// treat an unknown formatter as a permanent (non-retryable) failure.
const KNOWN_FORMATTERS = new Set<string>(["generic", "slack"]);

interface DeliveryRow {
  readonly deliveryId: string;
  readonly boardId: string;
  readonly ticketId: string;
  readonly connectionRef: string;
  readonly formatter: string;
  readonly contextJson: string;
  readonly attemptCount: number;
}

// Per-row delivery failure. `retryable=false` → permanent (e.g. malformed
// context_json, unknown formatter): park the row 'failed' immediately rather
// than burning attempts on something that can never succeed. `retryable=true`
// → transient (HTTP error, SSRF re-check, network/timeout, dangling conn):
// schedule a backoff.
interface DeliveryFailure {
  readonly message: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
}

const retryable = (message: string, retryAfterMs?: number): DeliveryFailure => ({
  message,
  retryable: true,
  ...(retryAfterMs !== undefined && { retryAfterMs }),
});

const permanent = (message: string): DeliveryFailure => ({ message, retryable: false });

// Per-POST body-drain timeout. With global fetch `client.execute` resolves once
// headers arrive; an undrained/slow body would otherwise block the concurrency:1
// sweep forever (Schedule.spaced cannot tick until sweep returns). Bound it so a
// target that stalls its response body can never freeze the dispatcher.
const BODY_DRAIN_TIMEOUT_MS = 10_000; // 10s

// Sanitize an HttpClientError for logging / `last_error` persistence WITHOUT
// leaking the target URL. The connection URL is the connection's stored SECRET
// (Slack/webhook URLs embed tokens), but `HttpClientError.message`/`String(err)`
// embed `${method} ${request.url}` via the reason's `methodAndUrl` getter — so we
// must NOT stringify the error. Surface only the reason `_tag` (TransportError,
// EncodeError, InvalidUrlError, …) and its URL-free `description` instead.
const describeTransportError = (cause: unknown): string => {
  if (HttpClientError.isHttpClientError(cause)) {
    const reason = cause.reason;
    return reason.description === undefined ? reason._tag : `${reason._tag}: ${reason.description}`;
  }
  // Non-HttpClientError (should not happen on this channel) — fall back to the
  // constructor name, never the stringified value, to stay URL-safe.
  return cause instanceof Error ? cause.name : "transport error";
};

// Decode the stored context_json through the schema (repo convention) so a
// malformed/truncated value is a TYPED failure (→ per-row backoff/park),
// never a synchronous throw that would become a sweep-aborting defect.
const decodeContext = Schema.decodeUnknownEffect(Schema.fromJsonString(OutboundEventContext));

const trimTrailingSlash = (value: string): string => value.replace(/\/+$/, "");

/** Parse a 429 `Retry-After` header (delta-seconds OR HTTP-date) into a delay
 * in ms from `nowMs`. Returns null if absent/unparseable → caller falls back to
 * exponential backoff. */
const parseRetryAfterMs = (raw: string | undefined, nowMs: number): number | null => {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  // delta-seconds form
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
  }
  // HTTP-date form
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, dateMs - nowMs);
  }
  return null;
};

export interface WorkflowOutboundDispatcherLiveOptions {
  readonly sweepIntervalMs?: number;
  readonly drainLimit?: number;
  /** Per-POST timeout (ms). Defaults to HTTP_TIMEOUT_MS; overridable in tests. */
  readonly httpTimeoutMs?: number;
  /** Base URL for absolute ticket links (Slack buttons need an absolute URL).
   * Undefined → ticketUrl is undefined → the Slack actions block is omitted. */
  readonly webBaseUrl?: URL | string | undefined;
  /** Injectable for hermetic tests; defaults to the real SSRF validator. */
  readonly validate?: typeof OutboundUrlValidator.validate;
}

/**
 * The atomic outbound-delivery claim: flip a 'pending' row to 'processing',
 * RETURNING the id ONLY when this call actually transitioned it. Exported so the
 * concurrency test runs the SAME statement production does — a copied SQL string
 * in the test could drift from this one (e.g. drop the `delivery_state = 'pending'`
 * guard) and still pass, hiding a real regression. Both callers share this one.
 */
export const claimOutboundDeliveryRow = (sql: SqlClient.SqlClient, deliveryId: string) =>
  sql<{ readonly deliveryId: string }>`
    UPDATE workflow_outbound_delivery
    SET delivery_state = 'processing'
    WHERE delivery_id = ${deliveryId} AND delivery_state = 'pending'
    RETURNING delivery_id AS "deliveryId"
  `;

const makeWorkflowOutboundDispatcher = (options?: WorkflowOutboundDispatcherLiveOptions) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const client = yield* HttpClient.HttpClient;
    const store = yield* WorkflowOutboundConnectionStore;
    const serverEnvironment = yield* ServerEnvironment;

    const sweepIntervalMs = Math.max(1, options?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);
    const drainLimit = Math.max(1, Math.floor(options?.drainLimit ?? DEFAULT_DRAIN_LIMIT));
    const httpTimeoutMs = Math.max(1, options?.httpTimeoutMs ?? HTTP_TIMEOUT_MS);
    const validate = options?.validate ?? OutboundUrlValidator.validate;
    // webBaseUrl comes from Config.url, which accepts ANY scheme (ftp:, file:, …).
    // Only http(s) bases can produce a valid Slack button URL; anything else would
    // make Slack reject the message (400). Restrict the scheme here: a non-http(s)
    // (or unparseable) base is treated as ABSENT → ticketUrl undefined → the Slack
    // actions block is omitted and the message stays valid.
    const webBaseUrl = (() => {
      if (options?.webBaseUrl === undefined) return undefined;
      try {
        const parsed =
          options.webBaseUrl instanceof URL
            ? options.webBaseUrl
            : new URL(String(options.webBaseUrl));
        return parsed.protocol === "http:" || parsed.protocol === "https:"
          ? trimTrailingSlash(parsed.toString())
          : undefined;
      } catch {
        return undefined;
      }
    })();

    const buildTicketUrl = (
      envId: EnvironmentId,
      boardId: string,
      ticketId: string,
    ): string | undefined =>
      webBaseUrl === undefined
        ? undefined
        : `${webBaseUrl}/${encodeURIComponent(envId)}/board?boardId=${encodeURIComponent(
            boardId,
          )}&ticket=${encodeURIComponent(ticketId)}`;

    // Park a row 'failed' immediately (used for permanent failures + the
    // retryable attempt ceiling). Records attempt_count + last_error.
    const markFailed = (deliveryId: string, attempt: number, message: string) =>
      sql`
        UPDATE workflow_outbound_delivery
        SET delivery_state = 'failed',
            attempt_count = ${attempt},
            last_error = ${message}
        WHERE delivery_id = ${deliveryId}
      `;

    // Record a delivery outcome. A PERMANENT failure parks the row 'failed' at
    // once (no retry would ever succeed). A RETRYABLE failure increments attempt
    // and schedules a backoff; at the attempt ceiling it is parked 'failed'.
    // A 429/Retry-After delay is honored but CAPPED at BACKOFF_CAP_MS so a hostile
    // header can't park the row years out. Mirrors WorkflowSourceSyncer.recordFailure.
    const recordFailure = (row: DeliveryRow, failure: DeliveryFailure) =>
      Effect.gen(function* () {
        if (!failure.retryable) {
          // Permanent: keep attempt_count as-is; this is terminal, not a retry.
          yield* markFailed(row.deliveryId, row.attemptCount, failure.message);
          return;
        }
        const attempt = row.attemptCount + 1;
        if (attempt >= MAX_ATTEMPTS) {
          yield* markFailed(row.deliveryId, attempt, failure.message);
          return;
        }
        const exponentialMs = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** row.attemptCount);
        const delayMs =
          failure.retryAfterMs !== undefined
            ? Math.min(BACKOFF_CAP_MS, failure.retryAfterMs)
            : exponentialMs;
        const now = yield* DateTime.now;
        const nextAttemptAt = DateTime.formatIso(
          DateTime.addDuration(now, Duration.millis(delayMs)),
        );
        // Reset the row to 'pending' (it was claimed 'processing' before the
        // POST) so the backoff retry re-selects it on a future sweep.
        yield* sql`
          UPDATE workflow_outbound_delivery
          SET delivery_state = 'pending',
              attempt_count = ${attempt},
              next_attempt_at = ${nextAttemptAt},
              last_error = ${failure.message}
          WHERE delivery_id = ${row.deliveryId}
        `;
      });

    const markSent = (deliveryId: string) =>
      sql`
        UPDATE workflow_outbound_delivery
        SET delivery_state = 'sent', last_error = NULL
        WHERE delivery_id = ${deliveryId}
      `;

    // Atomically claim a 'pending' row by flipping it to 'processing'. The
    // RETURNING row is yielded ONLY when this UPDATE actually transitioned the
    // row, so across multiple server instances exactly one claimant proceeds to
    // POST — the others see an empty result and skip the row this sweep. The
    // Idempotency-Key header bounds duplicate side effects, but this prevents
    // the duplicate POST (and duplicate work) in the first place. A claimed row
    // is returned to 'pending' on a retryable failure (see recordFailure).
    // Delegates to the module-level statement so the concurrency test exercises
    // the EXACT same SQL (no copy that can silently drift from production).
    const claimRow = (deliveryId: string) =>
      claimOutboundDeliveryRow(sql, deliveryId).pipe(Effect.map((rows) => rows.length > 0));

    // Process ONE delivery row end-to-end. Network strictly outside any tx.
    // The effect's error channel is DeliveryFailure (typed): every expected
    // failure routes through the catch → recordFailure, so a bad row can never
    // become a sweep-aborting defect.
    const processRow = (row: DeliveryRow, envId: EnvironmentId): Effect.Effect<void> =>
      Effect.gen(function* () {
        // Atomic claim BEFORE any work: only the instance that flips this row
        // 'pending' → 'processing' proceeds; a concurrent sweep (same or another
        // instance) that lost the race skips it, so the target is POSTed once.
        const claimed = yield* claimRow(row.deliveryId);
        if (!claimed) {
          return;
        }

        // Decode context_json through the schema — a malformed/truncated value
        // is a PERMANENT failure (no retry could fix it), not a sweep-killing throw.
        const ctx = yield* decodeContext(row.contextJson).pipe(
          Effect.mapError((e) => permanent(`malformed context_json: ${e.message}`)),
        );

        // Unknown formatter: renderOutbound silently downgrades to generic, which
        // would POST the wrong shape — reject it as a PERMANENT failure instead.
        if (!KNOWN_FORMATTERS.has(row.formatter)) {
          return yield* Effect.fail(permanent(`unknown formatter: ${row.formatter}`));
        }
        const formatter = row.formatter as OutboundFormatter;

        // Resolve the connection target. A dangling ref → retryable failure
        // (backoff), NOT a sweep abort.
        const target = yield* store
          .getTarget(row.connectionRef)
          .pipe(Effect.mapError((e) => retryable(`connection unresolved: ${e.reason}`)));

        // TOCTOU re-check at delivery time: a now-private host → retryable failure
        // + backoff (no POST). Mirrors the SSRF re-validation requirement.
        yield* validate(target.url).pipe(
          Effect.mapError((e) => retryable(`SSRF re-check failed: ${e.reason}`)),
        );

        const ticketUrl = buildTicketUrl(envId, row.boardId, row.ticketId);
        // renderOutbound is pure but could throw on unexpected input; run it in a
        // typed-failure boundary so a render throw is a backoff, not a defect.
        // exactOptionalPropertyTypes: only set ticketUrl when defined.
        const { body, contentType } = yield* Effect.try({
          try: () =>
            renderOutbound(formatter, ctx, {
              connection: target,
              ...(ticketUrl !== undefined && { ticketUrl }),
            }),
          catch: (e) => retryable(`render failed: ${String(e)}`),
        });

        const request = HttpClientRequest.post(target.url).pipe(
          HttpClientRequest.setHeader("Idempotency-Key", row.deliveryId),
          HttpClientRequest.bodyText(body, contentType),
        );

        // Bound the POST so one hung target can't freeze the (concurrency:1)
        // sweep. timeoutOrElse maps the timeout to a retryable typed failure.
        const response = yield* client.execute(request).pipe(
          // Do NOT stringify `cause`: HttpClientError.message embeds the target
          // URL, which is a stored secret (token-bearing webhook/Slack URL). Use a
          // URL-free description so the secret never reaches `last_error`/logs.
          Effect.mapError((cause) =>
            retryable(`HTTP network error: ${describeTransportError(cause)}`),
          ),
          Effect.timeoutOrElse({
            duration: Duration.millis(httpTimeoutMs),
            orElse: () => Effect.fail(retryable(`HTTP timeout after ${httpTimeoutMs}ms`)),
          }),
        );

        const { status, headers } = response;

        // Always drain (read + discard) the body before acting on status — with
        // global fetch an undrained body can retain the socket. Errors here are
        // ignored; the status has already been read. BOUND the drain: execute()
        // resolves once headers arrive, so a target that trickles/never finishes
        // the body would otherwise block this concurrency:1 sweep indefinitely
        // (the execute() timeout above does NOT cover the lazy body stream). A
        // drain timeout interrupts the read so the sweep always advances.
        yield* response.text.pipe(
          Effect.timeoutOrElse({
            duration: Duration.millis(BODY_DRAIN_TIMEOUT_MS),
            orElse: () => Effect.void,
          }),
          Effect.ignore,
        );

        if (status >= 200 && status < 300) {
          yield* markSent(row.deliveryId);
          return;
        }

        if (status === 429) {
          const now = yield* Clock.currentTimeMillis;
          const retryAfterMs = parseRetryAfterMs(headers["retry-after"], now);
          return yield* Effect.fail(
            retryAfterMs !== null
              ? retryable("HTTP 429 (rate limited)", retryAfterMs)
              : retryable("HTTP 429 (rate limited)"),
          );
        }

        return yield* Effect.fail(retryable(`HTTP ${status}`));
      }).pipe(
        // Mirror the notification dispatcher's exact catchAllCause idiom: re-raise
        // defects (programming bugs) to the sweep-level guard; only swallow
        // expected/typed failures as a recorded per-row outcome so one bad row
        // can't abort the whole sweep.
        Effect.catchCause((cause) =>
          Cause.hasDies(cause) || Cause.hasInterrupts(cause)
            ? Effect.die(Cause.squash(cause))
            : Effect.gen(function* () {
                // Non-defect branch: squash yields the original DeliveryFailure.
                const squashed = Cause.squash(cause);
                const failure: DeliveryFailure =
                  squashed !== null && typeof squashed === "object" && "retryable" in squashed
                    ? (squashed as DeliveryFailure)
                    : retryable(String(squashed));
                yield* Effect.logWarning("workflow.outbound.row-failed", {
                  deliveryId: row.deliveryId,
                  ticketId: row.ticketId,
                  retryable: failure.retryable,
                  message: failure.message,
                });
                yield* recordFailure(row, failure).pipe(
                  Effect.catchCause((recordCause) =>
                    Cause.hasDies(recordCause) || Cause.hasInterrupts(recordCause)
                      ? Effect.die(Cause.squash(recordCause))
                      : Effect.logWarning("workflow.outbound.record-failure-failed", {
                          deliveryId: row.deliveryId,
                          recordCause,
                        }),
                  ),
                );
              }),
        ),
      );

    const sweep: WorkflowOutboundDispatcherShape["sweep"] = () =>
      Effect.gen(function* () {
        const nowIso = DateTime.formatIso(yield* DateTime.now);
        const rows = yield* sql<DeliveryRow>`
          SELECT
            delivery_id AS "deliveryId",
            board_id AS "boardId",
            ticket_id AS "ticketId",
            connection_ref AS "connectionRef",
            formatter,
            context_json AS "contextJson",
            attempt_count AS "attemptCount"
          FROM workflow_outbound_delivery
          WHERE delivery_state = 'pending'
            AND (next_attempt_at IS NULL OR next_attempt_at <= ${nowIso})
          ORDER BY created_at ASC
          LIMIT ${drainLimit}
        `.pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("workflow.outbound.select-failed", { cause }).pipe(
              Effect.as([] as ReadonlyArray<DeliveryRow>),
            ),
          ),
        );

        if (rows.length === 0) {
          return;
        }

        // Resolve the environment id once per sweep (same source as the
        // notification dispatcher — ServerEnvironment.getEnvironmentId).
        const envId = yield* serverEnvironment.getEnvironmentId;

        yield* Effect.forEach(rows, (row) => processRow(row, envId), {
          concurrency: 1,
          discard: true,
        });
      });

    // Reset rows stranded 'processing' by a crash (after claimRow, before
    // markSent/recordFailure) back to 'pending'. The sweep selects only
    // 'pending', so without this a stranded row is never retried. Boot-time
    // reset matches recovery-on-restart semantics: at startup no live fiber
    // owns any 'processing' row, so flipping them all is safe. A select/UPDATE
    // failure is logged and swallowed — it must not block dispatcher start.
    const recoverStaleClaims: WorkflowOutboundDispatcherShape["recoverStaleClaims"] = () =>
      sql`
        UPDATE workflow_outbound_delivery
        SET delivery_state = 'pending'
        WHERE delivery_state = 'processing'
      `.pipe(
        Effect.asVoid,
        Effect.catchCause((cause) =>
          Effect.logWarning("workflow.outbound.recover-stale-claims-failed", { cause }),
        ),
      );

    const start: WorkflowOutboundDispatcherShape["start"] = () =>
      Effect.gen(function* () {
        // Reclaim stranded rows before the sweep loop so the very first sweep
        // picks them up.
        yield* recoverStaleClaims();
        yield* Effect.forkScoped(
          sweep().pipe(
            Effect.catchDefect((defect: unknown) =>
              Effect.logWarning("workflow.outbound.sweep-defect", { defect }),
            ),
            Effect.repeat(Schedule.spaced(Duration.millis(sweepIntervalMs))),
          ),
        );

        yield* Effect.logInfo("workflow.outbound.started", { sweepIntervalMs });
      });

    return { sweep, recoverStaleClaims, start } satisfies WorkflowOutboundDispatcherShape;
  });

export const makeWorkflowOutboundDispatcherLive = (
  options?: WorkflowOutboundDispatcherLiveOptions,
) => Layer.effect(WorkflowOutboundDispatcher, makeWorkflowOutboundDispatcher(options));

export const WorkflowOutboundDispatcherLive = makeWorkflowOutboundDispatcherLive();
