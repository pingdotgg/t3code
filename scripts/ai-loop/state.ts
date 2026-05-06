import { AI_LOOP_SCHEMA_VERSION, type StickyAiLoopState } from "./schema";

export const AI_LOOP_STATE_MARKER = "ai-loop-state-v1";

const STATE_REGEX = new RegExp(`<!--\\s*${AI_LOOP_STATE_MARKER}\\s*([\\s\\S]*?)\\s*-->`, "m");

const emptyTimestamp = (): string => "";

const assertRecord = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Sticky AI loop state must be an object.");
  }

  return value as Record<string, unknown>;
};

export const createDefaultStickyState = (owner: string, currentSha: string): StickyAiLoopState => ({
  schema_version: AI_LOOP_SCHEMA_VERSION,
  owner,
  status: "idle",
  generation_sha: currentSha,
  current_sha: currentSha,
  attempts_used: 0,
  last_signal_fingerprint: "",
  last_result_fingerprint: "",
  last_processed_at: emptyTimestamp(),
  last_signal_at: emptyTimestamp(),
  burst_started_at: emptyTimestamp(),
  blocked_reason: null,
  paused: false,
  executor_run_id: null,
});

export const migrateStickyState = (
  raw: unknown,
  fallback: StickyAiLoopState,
): StickyAiLoopState => {
  const record = assertRecord(raw);

  return {
    schema_version: AI_LOOP_SCHEMA_VERSION,
    owner: typeof record.owner === "string" ? record.owner : fallback.owner,
    status:
      typeof record.status === "string"
        ? (record.status as StickyAiLoopState["status"])
        : fallback.status,
    generation_sha:
      typeof record.generation_sha === "string" ? record.generation_sha : fallback.generation_sha,
    current_sha: typeof record.current_sha === "string" ? record.current_sha : fallback.current_sha,
    attempts_used:
      typeof record.attempts_used === "number" ? record.attempts_used : fallback.attempts_used,
    last_signal_fingerprint:
      typeof record.last_signal_fingerprint === "string"
        ? record.last_signal_fingerprint
        : fallback.last_signal_fingerprint,
    last_result_fingerprint:
      typeof record.last_result_fingerprint === "string"
        ? record.last_result_fingerprint
        : fallback.last_result_fingerprint,
    last_processed_at:
      typeof record.last_processed_at === "string"
        ? record.last_processed_at
        : fallback.last_processed_at,
    last_signal_at:
      typeof record.last_signal_at === "string" ? record.last_signal_at : fallback.last_signal_at,
    burst_started_at:
      typeof record.burst_started_at === "string"
        ? record.burst_started_at
        : fallback.burst_started_at,
    blocked_reason:
      typeof record.blocked_reason === "string" || record.blocked_reason === null
        ? record.blocked_reason
        : fallback.blocked_reason,
    paused: typeof record.paused === "boolean" ? record.paused : fallback.paused,
    executor_run_id:
      typeof record.executor_run_id === "string" || record.executor_run_id === null
        ? record.executor_run_id
        : fallback.executor_run_id,
  };
};

export const parseStickyState = (
  body: string,
  fallback: StickyAiLoopState,
): StickyAiLoopState | null => {
  const match = body.match(STATE_REGEX);
  if (!match?.[1]) {
    return null;
  }

  try {
    return migrateStickyState(JSON.parse(match[1]) as unknown, fallback);
  } catch {
    return fallback;
  }
};

export const renderStickyState = (state: StickyAiLoopState): string =>
  `<!-- ${AI_LOOP_STATE_MARKER}\n${JSON.stringify(state, null, 2)}\n-->`;
