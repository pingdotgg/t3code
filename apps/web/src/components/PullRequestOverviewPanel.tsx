import type { EnvironmentId } from "@t3tools/contracts";
import {
  AlertCircleIcon,
  CheckIcon,
  CircleDashedIcon,
  ExternalLinkIcon,
  GitBranchIcon,
  XIcon,
} from "lucide-react";
import { useMemo } from "react";

import { gitPrEnvironment } from "~/state/gitPr";
import { useEnvironmentQuery } from "~/state/query";
import { cn } from "~/lib/utils";
import ChatMarkdown from "./ChatMarkdown";
import { Spinner } from "./ui/spinner";

interface PullRequestOverviewPanelProps {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  prNumber: number;
  prUrl?: string | null | undefined;
  onSwitchToFiles: () => void;
  onSwitchToConversation: () => void;
}

function luminance(hex: string): number {
  const raw = hex.replace("#", "");
  const r = parseInt(raw.substring(0, 2), 16) / 255;
  const g = parseInt(raw.substring(2, 4), 16) / 255;
  const b = parseInt(raw.substring(4, 6), 16) / 255;
  const toLinear = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

function labelForeground(hex: string): string {
  return luminance(hex) > 0.4 ? "#000000" : "#ffffff";
}

const REVIEW_STATE_STYLES: Record<string, string> = {
  APPROVED: "text-emerald-600 dark:text-emerald-300",
  CHANGES_REQUESTED: "text-destructive",
  COMMENTED: "text-blue-600 dark:text-blue-300",
  PENDING: "text-amber-600 dark:text-amber-300",
  DISMISSED: "text-muted-foreground line-through",
};

const REVIEW_STATE_LABELS: Record<string, string> = {
  APPROVED: "Approved",
  CHANGES_REQUESTED: "Changes requested",
  COMMENTED: "Commented",
  PENDING: "Pending",
  DISMISSED: "Dismissed",
};

function MergeableBadge({ mergeable }: { mergeable: string }) {
  if (mergeable === "MERGEABLE") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-300">
        <CheckIcon className="size-3" />
        Mergeable
      </span>
    );
  }
  if (mergeable === "CONFLICTING") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-destructive/30 bg-destructive/10 px-2 py-0.5 text-[11px] font-medium text-destructive">
        <XIcon className="size-3" />
        Conflicts
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-muted-foreground/30 bg-muted/60 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
      <CircleDashedIcon className="size-3" />
      {mergeable || "Unknown"}
    </span>
  );
}

function ReviewDecisionBadge({ decision }: { decision: string }) {
  if (!decision) return null;
  const map: Record<string, { label: string; className: string }> = {
    APPROVED: {
      label: "Approved",
      className: "border-emerald-500/25 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300",
    },
    CHANGES_REQUESTED: {
      label: "Changes requested",
      className: "border-destructive/30 bg-destructive/10 text-destructive",
    },
    REVIEW_REQUIRED: {
      label: "Review required",
      className: "border-amber-500/25 bg-amber-500/10 text-amber-600 dark:text-amber-300",
    },
  };
  const info = map[decision];
  if (!info) return null;
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium",
        info.className,
      )}
    >
      {info.label}
    </span>
  );
}

export default function PullRequestOverviewPanel({
  environmentId,
  cwd,
  prNumber,
  prUrl,
  onSwitchToFiles,
  onSwitchToConversation,
}: PullRequestOverviewPanelProps) {
  const {
    data: detail,
    isLoading,
    error,
  } = useEnvironmentQuery(
    environmentId !== null && cwd !== null
      ? gitPrEnvironment.pullRequestDetail({ environmentId, input: { cwd, prNumber } })
      : null,
  );

  const checksGrouped = useMemo(() => {
    if (!detail) return null;
    const failing = detail.checks.filter((c) => c.status === "fail");
    const pending = detail.checks.filter((c) => c.status === "pending");
    const passing = detail.checks.filter((c) => c.status === "pass");
    return { failing, pending, passing };
  }, [detail]);

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="size-5 text-muted-foreground" />
      </div>
    );
  }

  // Keep showing the last good detail if a background refresh failed; only fall
  // back to the error state when there is nothing cached to display.
  if (!detail) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
        <AlertCircleIcon className="size-5 text-destructive" />
        <p className="text-sm text-destructive">
          {error ?? "Failed to load pull request details."}
        </p>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="space-y-5 p-4">
        {/* ── Header ─────────────────────────────────────────── */}
        <div className="space-y-2">
          <div className="flex items-start gap-2">
            <h2 className="flex-1 text-base font-semibold leading-snug text-foreground">
              {detail.title} <span className="font-normal text-muted-foreground">#{prNumber}</span>
            </h2>
            {detail.isDraft ? (
              <span className="mt-0.5 inline-flex shrink-0 items-center rounded-full border border-muted-foreground/30 bg-muted/60 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                Draft
              </span>
            ) : (
              <span className="mt-0.5 inline-flex shrink-0 items-center rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-300">
                Open
              </span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>{detail.author}</span>
            <span className="inline-flex items-center gap-1">
              <GitBranchIcon className="size-3" />
              <code className="rounded bg-muted px-1 py-0.5 text-[11px]">{detail.headRefName}</code>
              <span>→</span>
              <code className="rounded bg-muted px-1 py-0.5 text-[11px]">{detail.baseRefName}</code>
            </span>
            {prUrl && (
              <a
                href={prUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline dark:text-blue-400"
              >
                <ExternalLinkIcon className="size-3" />
                View on GitHub
              </a>
            )}
          </div>
        </div>

        {/* ── Stats row ──────────────────────────────────────── */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">
            +{detail.additions}
          </span>
          <span className="text-xs font-medium text-red-600 dark:text-red-400">
            -{detail.deletions}
          </span>
          <MergeableBadge mergeable={detail.mergeable} />
          <ReviewDecisionBadge decision={detail.reviewDecision} />
        </div>

        {/* ── Checks ─────────────────────────────────────────── */}
        {checksGrouped && detail.checks.length > 0 && (
          <section className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Checks
            </h3>
            <div className="flex gap-3 text-[11px] text-muted-foreground">
              {checksGrouped.failing.length > 0 && (
                <span className="inline-flex items-center gap-1 text-destructive">
                  <XIcon className="size-3" />
                  {checksGrouped.failing.length} failing
                </span>
              )}
              {checksGrouped.pending.length > 0 && (
                <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-300">
                  <CircleDashedIcon className="size-3" />
                  {checksGrouped.pending.length} pending
                </span>
              )}
              {checksGrouped.passing.length > 0 && (
                <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-300">
                  <CheckIcon className="size-3" />
                  {checksGrouped.passing.length} passing
                </span>
              )}
            </div>
            <div className="space-y-0.5">
              {[...checksGrouped.failing, ...checksGrouped.pending, ...checksGrouped.passing].map(
                (check) => {
                  const Icon =
                    check.status === "fail"
                      ? XIcon
                      : check.status === "pending"
                        ? CircleDashedIcon
                        : CheckIcon;
                  const color =
                    check.status === "fail"
                      ? "text-destructive"
                      : check.status === "pending"
                        ? "text-amber-600 dark:text-amber-300"
                        : "text-emerald-600 dark:text-emerald-300";
                  return (
                    <div key={check.name} className="flex items-center gap-1.5 text-xs">
                      <Icon className={cn("size-3 shrink-0", color)} />
                      <span className="truncate text-foreground">{check.name}</span>
                    </div>
                  );
                },
              )}
            </div>
          </section>
        )}

        {/* ── Reviewers ──────────────────────────────────────── */}
        {detail.reviewers.length > 0 && (
          <section className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Reviewers
            </h3>
            <div className="space-y-1">
              {detail.reviewers.map((r) => (
                <div key={r.login} className="flex items-center gap-2 text-xs">
                  <span className="font-medium text-foreground">{r.login}</span>
                  <span
                    className={cn(
                      "text-[11px]",
                      REVIEW_STATE_STYLES[r.state] ?? "text-muted-foreground",
                    )}
                  >
                    {REVIEW_STATE_LABELS[r.state] ?? r.state}
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* ── Labels ─────────────────────────────────────────── */}
        {detail.labels.length > 0 && (
          <section className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Labels
            </h3>
            <div className="flex flex-wrap gap-1.5">
              {detail.labels.map((label) => {
                const bg = `#${label.color.replace("#", "")}`;
                return (
                  <span
                    key={label.name}
                    className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium"
                    style={{
                      backgroundColor: bg,
                      color: labelForeground(bg),
                    }}
                  >
                    {label.name}
                  </span>
                );
              })}
            </div>
          </section>
        )}

        {/* ── Assignees & Milestone ──────────────────────────── */}
        {(detail.assignees.length > 0 || detail.milestone) && (
          <section className="space-y-2">
            {detail.assignees.length > 0 && (
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Assignees
                </h3>
                <p className="mt-1 text-xs text-foreground">{detail.assignees.join(", ")}</p>
              </div>
            )}
            {detail.milestone && (
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Milestone
                </h3>
                <p className="mt-1 text-xs text-foreground">{detail.milestone}</p>
              </div>
            )}
          </section>
        )}

        {/* ── PR Body ────────────────────────────────────────── */}
        {detail.body && (
          <section className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Description
            </h3>
            <div className="rounded-md border border-border/70 bg-muted/30 p-3">
              <ChatMarkdown text={detail.body} cwd={undefined} />
            </div>
          </section>
        )}

        {/* ── Next steps ─────────────────────────────────────── */}
        <section className="rounded-md border border-border/70 bg-muted/40 p-3 space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Next steps
          </h3>
          <div className="space-y-1 text-xs text-foreground">
            {checksGrouped && checksGrouped.failing.length > 0 && (
              <p className="text-destructive">
                {checksGrouped.failing.length} check
                {checksGrouped.failing.length > 1 ? "s" : ""} failing
              </p>
            )}
            {detail.reviewDecision && (
              <p>
                Review:{" "}
                <span
                  className={cn(
                    detail.reviewDecision === "APPROVED" &&
                      "text-emerald-600 dark:text-emerald-300",
                    detail.reviewDecision === "CHANGES_REQUESTED" && "text-destructive",
                    detail.reviewDecision === "REVIEW_REQUIRED" &&
                      "text-amber-600 dark:text-amber-300",
                  )}
                >
                  {REVIEW_STATE_LABELS[detail.reviewDecision] ??
                    detail.reviewDecision.replace(/_/g, " ").toLowerCase()}
                </span>
              </p>
            )}
            <p>
              Merge status:{" "}
              <span
                className={cn(
                  detail.mergeable === "MERGEABLE" && "text-emerald-600 dark:text-emerald-300",
                  detail.mergeable === "CONFLICTING" && "text-destructive",
                )}
              >
                {detail.mergeable
                  ? detail.mergeable.charAt(0) + detail.mergeable.slice(1).toLowerCase()
                  : "Unknown"}
              </span>
            </p>
          </div>
          <div className="flex gap-3 pt-1">
            <button
              type="button"
              onClick={onSwitchToFiles}
              className="text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
            >
              View files &rarr;
            </button>
            <button
              type="button"
              onClick={onSwitchToConversation}
              className="text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
            >
              View conversation &rarr;
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
