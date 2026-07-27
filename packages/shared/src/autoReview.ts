import type {
  AutoReviewDecision,
  AutoReviewFindings,
  AutoReviewFixModelMode,
  AutoReviewJob,
  AutoReviewJobStatus,
  AutoReviewMode,
  AutoReviewSettings,
  AutoReviewSeverity,
  AutoReviewTrigger,
  ModelSelection,
  ProjectId,
} from "@t3tools/contracts";
import {
  DEFAULT_AUTO_REVIEW_CONCURRENCY,
  DEFAULT_AUTO_REVIEW_FIX_CONCURRENCY,
  DEFAULT_AUTO_REVIEW_MAX_ATTEMPTS,
} from "@t3tools/contracts";

export const AUTO_REVIEW_POLL_INTERVAL_MIN_MS = 15_000;
export const AUTO_REVIEW_POLL_INTERVAL_MAX_MS = 600_000;
export const AUTO_REVIEW_MAX_ATTEMPTS_LIMIT = 10;
/**
 * Upper bound on both fan-outs. Each parallel slot is a full agent turn
 * (reviews shell out to `gh` and a model; fixes run a whole coding turn), so
 * the cap keeps a mis-set slider from saturating the machine and the GitHub
 * API. Distinct-PR / distinct-thread rules bound it further in practice.
 */
export const AUTO_REVIEW_CONCURRENCY_LIMIT = 8;

export interface ResolvedAutoReviewPolicy {
  readonly enabled: boolean;
  readonly mode: AutoReviewMode;
  readonly modelSelection: ModelSelection;
  readonly autoFixOriginThread: boolean;
  readonly fixModelMode: AutoReviewFixModelMode;
  /** Model the fix turn runs under, or null to keep the thread's own model. */
  readonly fixModelSelection: ModelSelection | null;
  readonly mentionHandle: string;
  readonly maxDiffBytes: number;
  readonly concurrency: number;
  readonly fixConcurrency: number;
  readonly maxAttempts: number;
}

export function resolveAutoReviewPolicy(
  settings: AutoReviewSettings,
  projectId: string,
): ResolvedAutoReviewPolicy {
  const override = (settings.projects ?? {})[projectId as ProjectId] ?? {};
  const projectEnabled = override.enabled ?? true;
  const rawHandle = override.mentionHandle ?? settings.mentionHandle ?? "surgecode";
  const handle = String(rawHandle).replace(/^@/u, "").trim();
  const modelSelection = override.modelSelection ?? settings.modelSelection;
  const fixModelMode = override.fixModelMode ?? settings.fixModelMode ?? "thread";
  return {
    enabled: Boolean(settings.enabled) && projectEnabled,
    mode: override.mode ?? settings.mode ?? "auto",
    modelSelection,
    autoFixOriginThread: override.autoFixOriginThread ?? settings.autoFixOriginThread ?? true,
    fixModelMode,
    fixModelSelection: resolveAutoReviewFixModel({
      fixModelMode,
      modelSelection,
      fixModelSelection: override.fixModelSelection ?? settings.fixModelSelection ?? null,
    }),
    mentionHandle: handle.length > 0 ? handle : "surgecode",
    maxDiffBytes: settings.maxDiffBytes ?? 400_000,
    concurrency: clampAutoReviewConcurrency(settings.concurrency, DEFAULT_AUTO_REVIEW_CONCURRENCY),
    fixConcurrency: clampAutoReviewConcurrency(
      settings.fixConcurrency,
      DEFAULT_AUTO_REVIEW_FIX_CONCURRENCY,
    ),
    maxAttempts: clampAutoReviewMaxAttempts(settings.maxAttempts),
  };
}

/**
 * Model override for the auto-fix turn, or null when the origin thread should
 * keep its own model. `custom` with no stored selection degrades to null
 * rather than silently reusing the reviewer: the user picked "a specific
 * model" and never named one, so changing nothing is the honest outcome.
 */
export function resolveAutoReviewFixModel(input: {
  readonly fixModelMode: AutoReviewFixModelMode;
  readonly modelSelection: ModelSelection;
  readonly fixModelSelection: ModelSelection | null | undefined;
}): ModelSelection | null {
  if (input.fixModelMode === "review") {
    return input.modelSelection;
  }
  if (input.fixModelMode === "custom") {
    return input.fixModelSelection ?? null;
  }
  return null;
}

export function clampAutoReviewConcurrency(
  value: number | undefined,
  fallback: number = DEFAULT_AUTO_REVIEW_CONCURRENCY,
): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(AUTO_REVIEW_CONCURRENCY_LIMIT, Math.max(1, Math.trunc(value)));
}

export function clampAutoReviewMaxAttempts(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_AUTO_REVIEW_MAX_ATTEMPTS;
  }
  return Math.min(AUTO_REVIEW_MAX_ATTEMPTS_LIMIT, Math.max(1, Math.trunc(value)));
}

/**
 * Decide whether a failed job for a (project, PR, headSha) chain may be
 * retried, and if so what the next 1-based attempt number is. Returns `null`
 * when the chain has exhausted `maxAttempts` and the poller must stop
 * re-enqueueing it.
 */
export function nextAutoReviewAttempt(input: {
  readonly latestJob: Pick<AutoReviewJob, "attempt" | "status"> | null | undefined;
  readonly maxAttempts: number;
}): number | null {
  const latest = input.latestJob;
  if (!latest || latest.status !== "failed") {
    return 1;
  }
  const cap = clampAutoReviewMaxAttempts(input.maxAttempts);
  if (latest.attempt >= cap) {
    return null;
  }
  return latest.attempt + 1;
}

const autoReviewPrKey = (job: { readonly projectId: string; readonly prNumber: number }) =>
  `${job.projectId}#${job.prNumber}`;

export type AutoReviewClaimCandidate = {
  readonly id: string;
  readonly projectId: string;
  readonly prNumber: number;
  readonly status: AutoReviewJobStatus;
};

/**
 * Pick the next batch of queued jobs to run in parallel, in FIFO order.
 *
 * Two reviews of the same pull request must never overlap: they would race on
 * the same head SHA and post duplicate GitHub reviews, and the second one's
 * findings would be redundant. So a PR with a job already running is skipped,
 * and at most one job per PR is taken per batch. Parallelism therefore only
 * materialises across *different* PRs, which is exactly the case the
 * concurrency setting exists for.
 */
export function selectClaimableAutoReviewJobs<T extends AutoReviewClaimCandidate>(input: {
  readonly jobs: ReadonlyArray<T>;
  readonly limit: number;
}): ReadonlyArray<T> {
  const limit = clampAutoReviewConcurrency(input.limit);
  const takenPrs = new Set(
    input.jobs.filter((job) => job.status === "running").map(autoReviewPrKey),
  );
  const picked: T[] = [];
  for (const job of input.jobs) {
    if (picked.length >= limit) {
      break;
    }
    if (job.status !== "queued") {
      continue;
    }
    const key = autoReviewPrKey(job);
    if (takenPrs.has(key)) {
      continue;
    }
    takenPrs.add(key);
    picked.push(job);
  }
  return picked;
}

export type AutoReviewFixSlotJob = {
  readonly autoFixEnqueued: boolean;
  readonly pendingFix: { readonly threadId: string } | null | undefined;
  readonly originThreadId?: string | null | undefined;
};

/**
 * Auto-fix turns currently occupying a concurrency slot, counted as distinct
 * busy origin threads.
 *
 * A dispatched fix holds its slot only while its thread is still working: once
 * the thread settles the fix is done and the slot frees up. Parked fixes
 * (`pendingFix`) hold nothing — they have not started. Threads are the unit
 * rather than jobs because a thread runs one turn at a time, so two jobs
 * pointing at the same thread cannot consume two slots.
 */
export function countInFlightAutoReviewFixes(input: {
  readonly jobs: ReadonlyArray<AutoReviewFixSlotJob>;
  readonly busyThreadIds: ReadonlySet<string>;
}): number {
  const threads = new Set<string>();
  for (const job of input.jobs) {
    if (!job.autoFixEnqueued || job.pendingFix != null) {
      continue;
    }
    const threadId = job.originThreadId == null ? null : String(job.originThreadId);
    if (threadId != null && input.busyThreadIds.has(threadId)) {
      threads.add(threadId);
    }
  }
  return threads.size;
}

export function matchAutoReviewMention(body: string, handle: string): boolean {
  const normalized = handle.replace(/^@/u, "").trim();
  if (!normalized) {
    return false;
  }
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const pattern = new RegExp(`(?:^|\\W)@${escaped}\\b`, "iu");
  return pattern.test(body);
}

export function mapFindingsToDecision(
  comments: ReadonlyArray<{ readonly severity: AutoReviewSeverity }>,
): AutoReviewDecision {
  if (comments.some((comment) => comment.severity === "blocking")) {
    return "request_changes";
  }
  // Always leave an audit trail in v1 — never auto-approve.
  return "comment";
}

export function shouldAutoFixOriginThread(findings: Pick<AutoReviewFindings, "comments">): boolean {
  return findings.comments.some(
    (comment) => comment.severity === "blocking" || comment.severity === "important",
  );
}

/**
 * Grace window for a queued turn start: session adoption takes seconds, so a
 * user message still unadopted after this bound is a failed start (or stale
 * data), not pending work. Mirrors QUEUED_TURN_START_GRACE_MS in
 * packages/client-runtime/src/state/threadSettled.ts.
 */
export const AUTO_REVIEW_QUEUED_TURN_START_GRACE_MS = 2 * 60 * 1_000;

/**
 * Whether the origin thread must not receive an auto-fix prompt right now.
 * Busy when the session is coming alive or working, the latest turn is still
 * running, or a queued turn start is in flight (a user message strictly newer
 * than every latest-turn timestamp within the adoption grace window). Mirrors
 * the hasQueuedTurnStart heuristic in threadSettled.ts and the server-side
 * twin in apps/server/src/orchestration/decider.ts, including the exemption
 * for a failed session start (status "error").
 */
export function isAutoReviewFixThreadBusy(input: {
  readonly sessionStatus: string | null;
  readonly latestTurnState: string | null;
  readonly latestUserMessageAt: string | null;
  readonly latestTurnTimestamps: ReadonlyArray<string | null>;
  readonly now: string;
}): boolean {
  if (input.sessionStatus === "starting" || input.sessionStatus === "running") {
    return true;
  }
  if (input.latestTurnState === "running") {
    return true;
  }
  // A failed session start clears the queued state: the failure is already
  // visible, not pending work.
  if (input.sessionStatus === "error") {
    return false;
  }
  if (input.latestUserMessageAt == null) {
    return false;
  }
  const messageAt = Date.parse(input.latestUserMessageAt);
  const nowMs = Date.parse(input.now);
  if (Number.isNaN(messageAt) || Number.isNaN(nowMs)) {
    return false;
  }
  // Bounded on both sides: message timestamps may come from a device whose
  // clock is ahead, and a negative age must not extend the busy window.
  if (Math.abs(nowMs - messageAt) > AUTO_REVIEW_QUEUED_TURN_START_GRACE_MS) {
    return false;
  }
  return input.latestTurnTimestamps.every(
    (candidate) => candidate == null || Date.parse(candidate) < messageAt,
  );
}

/**
 * Origin thread a job should be attributed to when projecting thread phases.
 *
 * A job is only assigned `originThreadId` when the runner finishes it, so
 * while it is queued/running it carries no linkage — attributing by stored id
 * alone would leave the thread's phase null for the whole review (the thread
 * reads as "done" while the reviewer is working). Active jobs are therefore
 * provisionally attributed with the same `linkOriginThread` heuristic the
 * runner applies on success, using the head branch captured at enqueue time.
 * Terminal jobs are never guessed: their linkage is whatever the runner wrote.
 */
export function resolveAutoReviewJobOriginThread(input: {
  readonly job: Pick<
    AutoReviewJob,
    "originThreadId" | "projectId" | "prNumber" | "headBranch" | "status"
  >;
  readonly candidates: ReadonlyArray<ThreadLinkCandidate>;
}): string | null {
  const job = input.job;
  if (job.originThreadId != null) {
    return String(job.originThreadId);
  }
  if (job.status !== "queued" && job.status !== "running") {
    return null;
  }
  if (job.headBranch == null || job.headBranch.length === 0) {
    return null;
  }
  return linkOriginThread({
    projectId: String(job.projectId),
    prNumber: job.prNumber,
    headBranch: job.headBranch,
    candidates: input.candidates,
  });
}

/**
 * Phase shown on a thread shell for auto-review activity. `jobs` must be
 * pre-filtered to the jobs relevant to this thread (origin-thread linkage,
 * plus unlinked queued/running jobs matched by the caller — see
 * `resolveAutoReviewJobOriginThread`).
 */
export function deriveAutoReviewThreadPhase(input: {
  readonly jobs: ReadonlyArray<AutoReviewJob>;
  readonly threadId: string;
  readonly threadBusy: boolean;
}): "reviewing" | "fixing" | "readyToMerge" | null {
  if (input.jobs.length === 0) {
    return null;
  }
  if (input.jobs.some((job) => job.status === "queued" || job.status === "running")) {
    return "reviewing";
  }
  const latestSucceeded = input.jobs
    .filter((job) => job.status === "succeeded")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (!latestSucceeded) {
    return null;
  }
  const hasPendingFix =
    latestSucceeded.pendingFix != null &&
    String(latestSucceeded.pendingFix.threadId) === input.threadId;
  if (hasPendingFix || (latestSucceeded.autoFixEnqueued && input.threadBusy)) {
    return "fixing";
  }
  if (!latestSucceeded.actionableFindings) {
    return "readyToMerge";
  }
  return null;
}

export function shouldEnqueueAutoReviewJob(input: {
  readonly mode: AutoReviewMode;
  readonly existingStatus: AutoReviewJobStatus | null | undefined;
  readonly trigger: AutoReviewTrigger;
  readonly isNewMentionComment?: boolean;
}): boolean {
  const existing = input.existingStatus;
  if (existing === "queued" || existing === "running") {
    return false;
  }

  if (input.trigger === "mention") {
    if (input.mode !== "mention") {
      return false;
    }
    if (input.isNewMentionComment) {
      return true;
    }
    return existing !== "succeeded";
  }

  // open_or_push
  if (input.mode !== "auto") {
    return false;
  }
  // Treat skipped (e.g. empty_diff) like terminal for this head SHA so the
  // poller does not thrash the same PR every tick.
  return existing !== "succeeded" && existing !== "skipped";
}

export function buildAutoReviewFooter(input: {
  readonly modelSelection: ModelSelection;
  readonly headSha: string;
}): string {
  const shortSha = input.headSha.trim().slice(0, 12);
  const model = `${input.modelSelection.instanceId}/${input.modelSelection.model}`;
  return `---\nSergeCode auto-review · model=${model} · head=${shortSha}`;
}

export function parseAutoReviewFooter(
  body: string,
): { readonly headSha: string; readonly model: string } | null {
  const match =
    /SergeCode auto-review · model=([^\s·]+) · head=([0-9a-f]{7,40})/iu.exec(body) ??
    /SergeCode auto-review · model=([^\s·]+) · head=([0-9a-fA-F]{7,40})/u.exec(body);
  if (!match?.[1] || !match[2]) {
    return null;
  }
  return { model: match[1], headSha: match[2].toLowerCase() };
}

export function buildOriginFixPrompt(input: {
  readonly prNumber: number;
  readonly prUrl: string;
  readonly headSha: string;
  readonly findings: Pick<AutoReviewFindings, "comments" | "summary">;
}): string {
  const highSignal = input.findings.comments.filter(
    (comment) => comment.severity === "blocking" || comment.severity === "important",
  );
  const bullets =
    highSignal.length === 0
      ? `- (see PR review summary)\n${input.findings.summary}`
      : highSignal
          .map(
            (comment) =>
              `- [${comment.severity}] ${comment.path}${comment.line != null ? `:${comment.line}` : ""} — ${comment.body}`,
          )
          .join("\n");

  return [
    "Please fix the actionable review comments on this pull request.",
    "",
    `PR: #${input.prNumber} (${input.prUrl})`,
    `Head: ${input.headSha}`,
    "",
    "SergeCode auto-review findings to address:",
    bullets,
    "",
    "Guidelines:",
    "- Use the gh CLI to fetch PR comments and review threads, including human reviewers and bot reviewers.",
    "- Start with gh pr view --comments, then use gh api graphql to inspect review threads and their resolved/outdated state.",
    "- Ignore comments that are resolved, outdated, purely informational, or nitpick-level unless they block correctness.",
    "- Implement the fixes, run the relevant checks, commit, and push to the PR branch.",
    "- Reply to each addressed comment with what changed, and resolve the corresponding review threads with gh api graphql where possible.",
    "- Summarize any comments you intentionally skipped and why.",
  ].join("\n");
}

export function clampAutoReviewPollIntervalMs(ms: number): number {
  if (!Number.isFinite(ms)) {
    return AUTO_REVIEW_POLL_INTERVAL_MIN_MS;
  }
  return Math.min(
    AUTO_REVIEW_POLL_INTERVAL_MAX_MS,
    Math.max(AUTO_REVIEW_POLL_INTERVAL_MIN_MS, Math.trunc(ms)),
  );
}

export type ThreadLinkCandidate = {
  readonly threadId: string;
  readonly projectId: string;
  readonly deletedAt: string | null;
  readonly updatedAt: string;
  readonly status: string;
  readonly prNumber: number | null;
  readonly prState: "open" | "closed" | "merged" | null;
  readonly branch: string | null;
};

export function linkOriginThread(input: {
  readonly projectId: string;
  readonly prNumber: number;
  readonly headBranch: string;
  readonly candidates: ReadonlyArray<ThreadLinkCandidate>;
}): string | null {
  const active = input.candidates.filter(
    (candidate) => candidate.projectId === input.projectId && candidate.deletedAt == null,
  );

  const byPr = active.filter(
    (candidate) =>
      candidate.prNumber === input.prNumber &&
      (candidate.prState === "open" || candidate.prState == null),
  );
  const byBranch = active.filter(
    (candidate) => candidate.branch != null && candidate.branch === input.headBranch,
  );

  const pool = byPr.length > 0 ? byPr : byBranch;
  if (pool.length === 0) {
    return null;
  }

  const ranked = [...pool].sort((left, right) => {
    const idleRank = (status: string) => (status === "idle" ? 0 : 1);
    const idleDiff = idleRank(left.status) - idleRank(right.status);
    if (idleDiff !== 0) {
      return idleDiff;
    }
    return right.updatedAt.localeCompare(left.updatedAt);
  });

  return ranked[0]?.threadId ?? null;
}
