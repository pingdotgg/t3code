export const AI_LOOP_SCHEMA_VERSION = 1;

export type AiLoopStatus =
  | "idle"
  | "queued"
  | "running"
  | "pushed_pending"
  | "clean"
  | "blocked"
  | "exhausted"
  | "paused";

export interface AiLoopConfig {
  schema_version: number;
  enabled: boolean;
  trusted_review_bots: string[];
  trusted_humans: string[];
  human_trigger_phrase: string;
  executor_owner: string;
  executor_bot_login: string;
  attempt_budget_per_generation: number;
  debounce_seconds: number;
  debounce_max_seconds: number;
  dispatch_grace_seconds: number;
  executor_timeout_seconds: number;
  pause_label: string;
  required_ci_checks: string[];
  prepush_commands: string[];
  legacy_workflows_present: string[];
}

export interface AiLoopPrMetadata {
  schema_version: number;
  owner: string;
  enabled: boolean;
  mode: "same-branch";
  human_comments_policy: "pr-author-only";
}

export interface StickyAiLoopState {
  schema_version: number;
  owner: string;
  status: AiLoopStatus;
  generation_sha: string;
  current_sha: string;
  attempts_used: number;
  last_signal_fingerprint: string;
  last_result_fingerprint: string;
  last_processed_at: string;
  last_signal_at: string;
  burst_started_at: string;
  blocked_reason: string | null;
  paused: boolean;
  executor_run_id: string | null;
}

export interface AiLoopFinding {
  schema_version: number;
  source: "check-run" | "review-comment" | "review-summary";
  source_actor: string;
  source_url: string;
  kind: string;
  path: string;
  line: number;
  severity: "low" | "medium" | "high";
  message: string;
  evidence: string;
  fingerprint: string;
  head_sha: string;
  category: "ci" | "review";
}
