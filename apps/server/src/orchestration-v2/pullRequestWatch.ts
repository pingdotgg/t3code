import type {
  OrchestrationV2Notification,
  PullRequestCheck,
  PullRequestComment,
  PullRequestDetail,
  ThreadPullRequestWatch,
} from "@t3tools/contracts";

/**
 * Wakes in a row that bring only comments. Check, conflict, or push news resets the count, so
 * this only stops a chatty bot looping an agent that is replying to it.
 */
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

// "action-required" is a finished check that needs someone, so the agent hears about it.
const isFailedCheck = (check: PullRequestCheck) =>
  check.status === "failure" || check.status === "cancelled" || check.status === "action-required";

/** The result once every check finished; null while one still runs or there are none. */
function checksResult(checks: ReadonlyArray<PullRequestCheck>): "passing" | "failed" | null {
  if (checks.length === 0 || checks.some((check) => check.status === "pending")) return null;
  return checks.some(isFailedCheck) ? "failed" : "passing";
}

/**
 * Compares a watched pull request with what its agent was last told. The check result is
 * reported once every check finished, and again after the head commit moves or checks run
 * again. Remarks count when someone other than the agent's own account wrote them, so its own
 * replies never wake it. `remarks` is null when
 * the conversation could not be read; remarks then wait for a later pass.
 */
export function evaluatePullRequestWatch(
  watch: ThreadPullRequestWatch,
  detail: Pick<PullRequestDetail, "headSha" | "checks" | "mergeability" | "viewer" | "author">,
  remarks: ReadonlyArray<PullRequestComment> | null,
): PullRequestWatchReport {
  const changes: Array<PullRequestWatchChange> = [];
  const headSha = detail.headSha ?? null;
  const result = checksResult(detail.checks);
  // Hosts that report no head commit still show a push or a rerun as checks running again. An
  // empty list is not a rerun: a host can answer with one when its check read fails.
  const restarted =
    headSha !== watch.headSha ||
    (watch.checks !== null && detail.checks.some((check) => check.status === "pending"));

  let checks = restarted ? null : watch.checks;
  if (result !== null && result !== checks) {
    changes.push(
      result === "passing"
        ? { kind: "checks-passed", count: detail.checks.length }
        : { kind: "checks-failed", failed: detail.checks.filter(isFailedCheck) },
    );
    checks = result;
  }

  // The agent posts as the viewer. Where the host does not name one, the agent most likely
  // opened the pull request, so its author stands in.
  const own = (detail.viewer ?? detail.author?.login)?.toLowerCase();
  const through = Date.parse(watch.remarksThrough);
  // GitHub times are per second, so remarks at the boundary time are told apart by ID.
  const fresh = (remarks ?? []).filter((remark) => {
    const at = Date.parse(remark.createdAt);
    return (
      (at > through || (at === through && !watch.remarkIds.includes(remark.id))) &&
      remark.author?.login.toLowerCase() !== own
    );
  });
  if (fresh.length > 0) changes.push({ kind: "remarks", remarks: fresh });
  const latest = Math.max(through, ...fresh.map((remark) => Date.parse(remark.createdAt)));
  const atLatest = fresh.filter((remark) => Date.parse(remark.createdAt) === latest);
  const remarksThrough = latest === through ? watch.remarksThrough : atLatest[0]!.createdAt;
  const remarkIds = [
    ...(latest === through ? watch.remarkIds : []),
    ...atLatest.map((remark) => remark.id),
  ];

  if (detail.mergeability === "conflicting" && !watch.conflicting) {
    changes.push({ kind: "conflicting" });
  }
  // "unknown" is GitHub still computing after a push; only a clean answer clears a conflict.
  const conflicting =
    detail.mergeability === "unknown" ? watch.conflicting : detail.mergeability === "conflicting";

  const commentsOnly = changes.length > 0 && changes.every((change) => change.kind === "remarks");
  const progress = restarted || (changes.length > 0 && !commentsOnly);
  const wakes = (progress ? 0 : watch.wakes) + (commentsOnly ? 1 : 0);
  return {
    changes,
    next: {
      startedAt: watch.startedAt,
      headSha,
      checks,
      remarksThrough,
      remarkIds,
      conflicting,
      wakes,
    },
    exhausted: commentsOnly && wakes >= PULL_REQUEST_WATCH_WAKE_LIMIT,
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
        ...listed(
          change.failed,
          (check) =>
            `  - ${check.name}${check.status === "failure" ? "" : ` (${check.status})`}${check.url ? ` ${check.url}` : ""}`,
        ),
      ];
    case "checks-passed":
      return [
        `- All ${change.count} ${change.count === 1 ? "check" : "checks"} finished without a failure${context.commit}.`,
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
      ? `T3 Code stopped watching after ${PULL_REQUEST_WATCH_WAKE_LIMIT} comment-only updates in a row. Call watch_pull_request to watch it again.`
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
