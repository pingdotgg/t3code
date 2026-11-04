// Codex sleeps silently for Retry-After; the adapter bounds that wait and reports a usage-limit failure.
export interface CodexRateLimitRetryPolicy {
  /** Highest retry attempt the adapter waits for. Later notices end the turn. */
  readonly maxAttempts: number;
  /** Expected wait for attempt 1 when no Retry-After is known; doubles per attempt. */
  readonly baseDelayMs: number;
  /** Longest single wait the adapter accepts, including a server Retry-After. */
  readonly maxDelayMs: number;
  /** Extra time after the expected wait for the retried request to show progress. */
  readonly progressGraceMs: number;
}

export const CODEX_RATE_LIMIT_RETRY_POLICY: CodexRateLimitRetryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 5_000,
  maxDelayMs: 5 * 60_000,
  progressGraceMs: 60_000,
};

// How long a stopped 429 turn may stay active after Codex failed to acknowledge its `turn/interrupt` (the request errored or timed out) and has not reported `turn/completed` either.
export const CODEX_RATE_LIMIT_UNCONFIRMED_STOP_TIMEOUT_MS = 60_000;

export type CodexRateLimitRetryDecision =
  | {
      readonly type: "wait";
      /** How long the provider is expected to wait before retrying. */
      readonly delayMs: number;
      /** How long the adapter waits for progress before ending the turn. */
      readonly deadlineMs: number;
    }
  | {
      readonly type: "give_up";
      readonly reason: "attempts_exhausted" | "retry_after_exceeds_max_delay";
    };

export function codexRateLimitBackoffMs(
  attempt: number,
  policy: CodexRateLimitRetryPolicy = CODEX_RATE_LIMIT_RETRY_POLICY,
): number {
  const exponent = Math.max(0, Math.floor(attempt) - 1);
  return Math.min(policy.baseDelayMs * 2 ** exponent, policy.maxDelayMs);
}

export function decideCodexRateLimitRetry(
  input: { readonly attempt: number; readonly retryAfterMs: number | null },
  policy: CodexRateLimitRetryPolicy = CODEX_RATE_LIMIT_RETRY_POLICY,
): CodexRateLimitRetryDecision {
  if (input.attempt > policy.maxAttempts) {
    return { type: "give_up", reason: "attempts_exhausted" };
  }
  if (input.retryAfterMs !== null && input.retryAfterMs > policy.maxDelayMs) {
    return { type: "give_up", reason: "retry_after_exceeds_max_delay" };
  }
  const delayMs = input.retryAfterMs ?? codexRateLimitBackoffMs(input.attempt, policy);
  return { type: "wait", delayMs, deadlineMs: delayMs + policy.progressGraceMs };
}

const UNIT_MS: Record<string, number> = {
  ms: 1,
  millisecond: 1,
  milliseconds: 1,
  s: 1_000,
  sec: 1_000,
  secs: 1_000,
  second: 1_000,
  seconds: 1_000,
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
};

const DELAY_UNIT = String.raw`milliseconds?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h`;

const RETRY_AFTER_DELAY = new RegExp(
  String.raw`retry[-_ ]?after([-_]ms)?["']?\s*[:=]?\s*["']?(\d+(?:\.\d+)?)(?:["']?[ \t]*(${DELAY_UNIT})\b)?`,
  "iu",
);

const RETRY_IN_PHRASE = new RegExp(
  String.raw`(?:try again|retry) in\s+(\d+(?:\.\d+)?)\s*(${DELAY_UNIT})\b`,
  "iu",
);

const toDelayMs = (amount: string, unitMs: number | undefined): number | null => {
  const value = Number.parseFloat(amount);
  return unitMs === undefined || !Number.isFinite(value) ? null : Math.round(value * unitMs);
};

// RFC 9110 lets Retry-After carry an IMF-fixdate instead of delay-seconds.
const RETRY_AFTER_HTTP_DATE =
  /retry[-_ ]?after["']?\s*[:=]?\s*["']?((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s*\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4}\s+\d{2}:\d{2}:\d{2}\s+GMT)/iu;

// Reads a retry delay from provider error text: a `Retry-After` header or field (seconds unless it names a unit, or an HTTP date measured from `nowMs` when the caller supplies it), a `retry-after-ms` header, a `reset_seconds` field, or "try again in N <unit>".
export function parseCodexRetryAfterMs(
  text: string | null | undefined,
  nowMs?: number,
): number | null {
  if (text == null || text.length === 0) return null;
  if (nowMs !== undefined) {
    const httpDate = RETRY_AFTER_HTTP_DATE.exec(text)?.[1];
    const retryAt = httpDate === undefined ? Number.NaN : Date.parse(httpDate);
    if (Number.isFinite(retryAt)) return Math.max(0, retryAt - nowMs);
  }
  const retryAfter = RETRY_AFTER_DELAY.exec(text);
  if (retryAfter?.[2] !== undefined) {
    // A bare value is delay-seconds; `retry-after-ms` and a named unit
    // ("retry after 2 minutes") override it.
    const unit =
      retryAfter[1] !== undefined ? UNIT_MS.ms : UNIT_MS[retryAfter[3]?.toLowerCase() ?? "s"];
    return toDelayMs(retryAfter[2], unit);
  }
  const resetSeconds = /reset_seconds["']?\s*[:=]\s*["']?(\d+(?:\.\d+)?)/iu.exec(text)?.[1];
  if (resetSeconds !== undefined) return toDelayMs(resetSeconds, UNIT_MS.s);
  const phrase = RETRY_IN_PHRASE.exec(text);
  if (phrase?.[1] === undefined || phrase[2] === undefined) return null;
  return toDelayMs(phrase[1], UNIT_MS[phrase[2].toLowerCase()]);
}

/** The HTTP status Codex attached to a structured error, whatever its variant. */
export function codexErrorHttpStatusCode(errorInfo: unknown): number | null {
  if (typeof errorInfo !== "object" || errorInfo === null) return null;
  for (const detail of Object.values(errorInfo)) {
    if (typeof detail === "object" && detail !== null && "httpStatusCode" in detail) {
      const status = (detail as { readonly httpStatusCode?: unknown }).httpStatusCode;
      if (typeof status === "number") return status;
    }
  }
  return null;
}

const TEXTUAL_HTTP_429 =
  /\btoo many requests\b|\b(?:http|status(?:[ _]?code)?)["']?\s*[:=]?\s*["']?429\b|^\s*429\b/imu;

/**
 * Whether provider error text reports HTTP 429. Codex's structured status is
 * optional, so the text is the fallback evidence when it is missing.
 */
export function codexErrorTextIndicatesHttp429(text: string | null | undefined): boolean {
  return text != null && TEXTUAL_HTTP_429.test(text);
}
