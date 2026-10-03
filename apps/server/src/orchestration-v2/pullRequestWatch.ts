import type {
  OrchestrationV2Notification,
  PullRequestCheck,
  PullRequestComment,
  PullRequestDetail,
  ThreadPullRequestWatch,
} from "@t3tools/contracts";

/**
 * Wakes allowed before checks start over (a push or a rerun), so a chatty bot cannot loop an
 * agent that is only replying to it.
 */
export const PULL_REQUEST_WATCH_WAKE_LIMIT = 10;
const LISTED_ITEMS = 10;
const SNIPPET_LENGTH = 200;

export type PullRequestWatchChange =
  | {
      readonly kind: "checks-failed";
      readonly failed: ReadonlyArray<PullRequestCheck>;
      /** Checks still running; a later report follows once they finish. */
      readonly running: number;
    }
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
const isRunningCheck = (check: PullRequestCheck) => check.status === "pending";

function checksOutcome(
  checks: ReadonlyArray<PullRequestCheck>,
): "passing" | "failing" | "failed" | "pending" | null {
  if (checks.length === 0) return null;
  const running = checks.some(isRunningCheck);
  if (checks.some(isFailedCheck)) return running ? "failing" : "failed";
  return running ? "pending" : "passing";
}

/**
 * Compares a watched pull request with what its agent was last told. A check result is
 * reported as soon as any check fails or once every check passed, and again only after the
 * head commit moves or the checks start over. Remarks count when someone other than the
 * viewer or the pull request's author wrote them: the agent posts as the viewer, so its own
 * replies never wake it. `remarks` is null when the conversation could not be read whole;
 * remarks are then left for a later pass rather than skipped.
 */
export function evaluatePullRequestWatch(
  watch: ThreadPullRequestWatch,
  detail: Pick<PullRequestDetail, "headSha" | "checks" | "mergeability" | "viewer" | "author">,
  remarks: ReadonlyArray<PullRequestComment> | null,
): PullRequestWatchReport {
  const changes: Array<PullRequestWatchChange> = [];
  const headSha = detail.headSha ?? null;
  const outcome = checksOutcome(detail.checks);
  // Hosts that report no head commit still show a push or a rerun as checks starting over.
  const restarted =
    headSha !== watch.headSha ||
    (watch.checks !== null && (outcome === "pending" || outcome === null));

  let checks = restarted ? null : watch.checks;
  // An early failure is reported while other checks run, and the final result once they finish.
  // A rerun that leaves another failure in place is recorded quietly and reported when it ends.
  if (checks === "failed" && outcome === "failing") {
    checks = "failing";
  } else if (outcome !== null && outcome !== "pending" && outcome !== checks) {
    changes.push(
      outcome === "passing"
        ? { kind: "checks-passed", count: detail.checks.length }
        : {
            kind: "checks-failed",
            failed: detail.checks.filter(isFailedCheck),
            running: detail.checks.filter(isRunningCheck).length,
          },
    );
    checks = outcome;
  }

  const own = new Set(
    [detail.viewer, detail.author?.login].flatMap((login) => (login ? [login.toLowerCase()] : [])),
  );
  const through = Date.parse(watch.remarksThrough);
  const fresh = (remarks ?? []).filter((remark) => {
    const at = Date.parse(remark.createdAt);
    return (
      (at > through || (at === through && !watch.remarkIds.includes(remark.id))) &&
      !own.has(remark.author?.login.toLowerCase() ?? "")
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

  const wakes = (restarted ? 0 : watch.wakes) + (changes.length > 0 ? 1 : 0);
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
        `- Checks failed${context.commit}${change.running > 0 ? ` (${change.running} still running)` : ""}:`,
        ...listed(
          change.failed,
          (check) =>
            `  - ${check.name}${check.status === "failure" ? "" : ` (${check.status})`}${check.url ? ` ${check.url}` : ""}`,
        ),
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
      ? `T3 Code stopped watching after ${PULL_REQUEST_WATCH_WAKE_LIMIT} updates without a new push or check run. Call watch_pull_request to watch it again.`
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
