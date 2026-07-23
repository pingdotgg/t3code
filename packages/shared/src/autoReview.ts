import type {
  AutoReviewDecision,
  AutoReviewFindings,
  AutoReviewJobStatus,
  AutoReviewMode,
  AutoReviewSettings,
  AutoReviewSeverity,
  AutoReviewTrigger,
  ModelSelection,
  ProjectId,
} from "@t3tools/contracts";

export const AUTO_REVIEW_POLL_INTERVAL_MIN_MS = 15_000;
export const AUTO_REVIEW_POLL_INTERVAL_MAX_MS = 600_000;

export interface ResolvedAutoReviewPolicy {
  readonly enabled: boolean;
  readonly mode: AutoReviewMode;
  readonly modelSelection: ModelSelection;
  readonly autoFixOriginThread: boolean;
  readonly mentionHandle: string;
  readonly maxDiffBytes: number;
  readonly concurrency: number;
}

export function resolveAutoReviewPolicy(
  settings: AutoReviewSettings,
  projectId: string,
): ResolvedAutoReviewPolicy {
  const override = (settings.projects ?? {})[projectId as ProjectId] ?? {};
  const projectEnabled = override.enabled ?? true;
  const rawHandle = override.mentionHandle ?? settings.mentionHandle ?? "surgecode";
  const handle = String(rawHandle).replace(/^@/u, "").trim();
  return {
    enabled: Boolean(settings.enabled) && projectEnabled,
    mode: override.mode ?? settings.mode ?? "auto",
    modelSelection: override.modelSelection ?? settings.modelSelection,
    autoFixOriginThread: override.autoFixOriginThread ?? settings.autoFixOriginThread ?? true,
    mentionHandle: handle.length > 0 ? handle : "surgecode",
    maxDiffBytes: settings.maxDiffBytes ?? 400_000,
    concurrency: settings.concurrency ?? 1,
  };
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

export function shouldAutoFixOriginThread(
  findings: Pick<AutoReviewFindings, "comments">,
): boolean {
  return findings.comments.some(
    (comment) => comment.severity === "blocking" || comment.severity === "important",
  );
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
    (candidate) =>
      candidate.projectId === input.projectId &&
      candidate.deletedAt == null,
  );

  const byPr = active.filter(
    (candidate) =>
      candidate.prNumber === input.prNumber &&
      (candidate.prState === "open" || candidate.prState == null),
  );
  const byBranch = active.filter(
    (candidate) =>
      candidate.branch != null &&
      candidate.branch === input.headBranch,
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
