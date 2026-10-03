import type {
  OrchestrationV2Notification,
  PullRequestActivity,
  PullRequestCheck,
  PullRequestComment,
  PullRequestDetail,
  ThreadPullRequestWatch,
} from "@t3tools/contracts";

/** Wakes allowed without a new push before watching stops, so a chatty bot cannot loop an agent. */
export const PULL_REQUEST_WATCH_WAKE_LIMIT = 10;
const LISTED_ITEMS = 10;
const SNIPPET_LENGTH = 200;

export type PullRequestWatchChange =
  | { readonly kind: "checks-failed"; readonly failed: ReadonlyArray<PullRequestCheck> }
  | { readonly kind: "checks-passed"; readonly count: number }
  | { readonly kind: "remarks"; readonly remarks: ReadonlyArray<PullRequestComment> }
  | { readonly kind: "conflicting" };

export interface PullRequestWatchReport {
  /** What the agent has not been told yet. Empty means no wake. */
  readonly changes: ReadonlyArray<PullRequestWatchChange>;
  /** The watch to record, whether or not anything is reported. */
  readonly next: ThreadPullRequestWatch;
  /** This report spends the last wake before the limit, so watching stops after it. */
  readonly exhausted: boolean;
}

const isFailedCheck = (check: PullRequestCheck) =>
  check.status === "failure" || check.status === "cancelled";

function checksOutcome(
  checks: ReadonlyArray<PullRequestCheck>,
): "passing" | "failing" | "pending" | null {
  if (checks.length === 0) return null;
  if (checks.some(isFailedCheck)) return "failing";
  if (checks.some((check) => check.status === "pending" || check.status === "action-required")) {
    return "pending";
  }
  return "passing";
}

/**
 * Compares a watched pull request with what its agent was last told. A check result is
 * reported once per head commit, as soon as any check fails or once every check passed.
 * Remarks count when someone other than the viewer or the pull request's author wrote them:
 * the agent posts as the viewer, so its own replies never wake it.
 */
export function evaluatePullRequestWatch(
  watch: ThreadPullRequestWatch,
  detail: Pick<PullRequestDetail, "headSha" | "checks" | "mergeability" | "viewer" | "author">,
  activity: Pick<PullRequestActivity, "comments">,
): PullRequestWatchReport {
  const changes: Array<PullRequestWatchChange> = [];
  const headSha = detail.headSha ?? null;
  const headMoved = headSha !== watch.headSha;

  let checks = headMoved ? null : watch.checks;
  const outcome = checksOutcome(detail.checks);
  if ((outcome === "failing" || outcome === "passing") && outcome !== checks) {
    changes.push(
      outcome === "failing"
        ? { kind: "checks-failed", failed: detail.checks.filter(isFailedCheck) }
        : { kind: "checks-passed", count: detail.checks.length },
    );
    checks = outcome;
  }

  const own = new Set(
    [detail.viewer, detail.author?.login].flatMap((login) => (login ? [login.toLowerCase()] : [])),
  );
  const reportedThrough = Date.parse(watch.remarksThrough);
  const remarks = activity.comments.filter(
    (remark) =>
      Date.parse(remark.createdAt) > reportedThrough &&
      !own.has(remark.author?.login.toLowerCase() ?? ""),
  );
  if (remarks.length > 0) changes.push({ kind: "remarks", remarks });
  const remarksThrough = remarks.reduce(
    (latest, remark) =>
      Date.parse(remark.createdAt) > Date.parse(latest) ? remark.createdAt : latest,
    watch.remarksThrough,
  );

  if (detail.mergeability === "conflicting" && !watch.conflicting) {
    changes.push({ kind: "conflicting" });
  }
  // "unknown" is GitHub still computing after a push; only a clean answer clears a conflict.
  const conflicting =
    detail.mergeability === "unknown" ? watch.conflicting : detail.mergeability === "conflicting";

  const wakes = (headMoved ? 0 : watch.wakes) + (changes.length > 0 ? 1 : 0);
  return {
    changes,
    next: { startedAt: watch.startedAt, headSha, checks, remarksThrough, conflicting, wakes },
    exhausted: changes.length > 0 && wakes >= PULL_REQUEST_WATCH_WAKE_LIMIT,
  };
}

function snippet(body: string): string {
  const text = body
    .replaceAll(/<!--[\s\S]*?-->/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim();
  return text.length <= SNIPPET_LENGTH ? text : `${text.slice(0, SNIPPET_LENGTH - 3)}...`;
}

function listed<T>(items: ReadonlyArray<T>, line: (item: T) => string): Array<string> {
  const lines = items.slice(0, LISTED_ITEMS).map(line);
  if (items.length > LISTED_ITEMS) lines.push(`  - and ${items.length - LISTED_ITEMS} more`);
  return lines;
}

function changeLines(
  change: PullRequestWatchChange,
  context: { readonly baseBranch: string; readonly commit: string },
): Array<string> {
  switch (change.kind) {
    case "checks-failed":
      return [
        `- Checks failed${context.commit}:`,
        ...listed(change.failed, (check) => `  - ${check.name}${check.url ? ` ${check.url}` : ""}`),
      ];
    case "checks-passed":
      return [
        `- All ${change.count} ${change.count === 1 ? "check" : "checks"} passed${context.commit}.`,
      ];
    case "remarks":
      return [
        `- ${change.remarks.length} new ${change.remarks.length === 1 ? "comment" : "comments"}:`,
        ...listed(change.remarks, (remark) => {
          const where = remark.path === null ? "" : ` on ${remark.path}`;
          const body = snippet(remark.body);
          const said = body.length === 0 ? (remark.reviewState ?? "reviewed") : `"${body}"`;
          return `  - ${remark.author?.login ?? "someone"}${where}: ${said}${remark.url ? ` ${remark.url}` : ""}`;
        }),
      ];
    case "conflicting":
      return [`- The branch now conflicts with ${context.baseBranch}.`];
  }
}

const SUMMARY: Record<PullRequestWatchChange["kind"], string> = {
  "checks-failed": "checks failed",
  "checks-passed": "checks passed",
  remarks: "new comments",
  conflicting: "merge conflict",
};

/** The wake the agent reads and the timeline notification the user sees. */
export function pullRequestWatchMessage(input: {
  readonly number: number;
  readonly url: string;
  readonly baseBranch: string;
  readonly headSha: string | null;
  readonly report: PullRequestWatchReport;
}): { readonly text: string; readonly notification: OrchestrationV2Notification } {
  const { changes, exhausted } = input.report;
  const context = {
    baseBranch: input.baseBranch,
    commit: input.headSha === null ? "" : ` on ${input.headSha.slice(0, 7)}`,
  };
  const text = [
    `Update on pull request #${input.number} (${input.url}), which T3 Code is watching for you:`,
    ...changes.flatMap((change) => changeLines(change, context)),
    "",
    exhausted
      ? `T3 Code stopped watching after ${PULL_REQUEST_WATCH_WAKE_LIMIT} updates without a new push. Call watch_pull_request to watch it again.`
      : "Look into each item and act on it as your task requires. T3 Code keeps watching and wakes you on the next change, so end your turn when you are done. Call unwatch_pull_request when you no longer need updates.",
  ].join("\n");
  const failed = changes.some(
    (change) => change.kind === "checks-failed" || change.kind === "conflicting",
  );
  const summary = changes.map((change) => SUMMARY[change.kind]);
  if (exhausted) summary.push("stopped watching");
  return {
    text,
    notification: {
      source: { kind: "monitor" },
      outcome: failed
        ? "failed"
        : changes.every((change) => change.kind === "checks-passed")
          ? "completed"
          : "updated",
      summary: `#${input.number}: ${summary.join(", ")}`,
    },
  };
}
