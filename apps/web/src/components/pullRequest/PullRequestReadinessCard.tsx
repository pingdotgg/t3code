/**
 * The top of the Summary tab: whether this pull request can merge, one expandable row per thing
 * that decides it (checks, reviews, conflicts), and the merge itself under them. The merge control
 * and its menu are built by the detail panel, which owns every action; this card only lays out
 * the answer and the rows that explain it.
 */
import type {
  EnvironmentId,
  PullRequestCheck,
  PullRequestChecksState,
  PullRequestDetailView,
  PullRequestRef,
  PullRequestUpdateMethod,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { ChevronDownIcon, ChevronRightIcon, HammerIcon, PlayIcon } from "lucide-react";
import { useState, type MouseEvent, type ReactNode, type RefCallback } from "react";

import { useOpenLink } from "~/browser/useOpenLink";
import { cn } from "~/lib/utils";
import { RelativeTime } from "~/components/RelativeTime";

import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Group } from "../ui/group";
import { Menu, MenuPopup, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  latestPullRequestReviewOutcomes,
  pullRequestFindingKey,
  type PullRequestFinding,
} from "./pullRequestDetail.logic";
import { PullRequestGlyph } from "./pullRequestIcons";
import {
  PullRequestActorLabel,
  PullRequestCheckStatusIcon,
  pullRequestCheckStatusLabel,
  pullRequestChecksStatePresentation,
  PullRequestReviewOutcomeIcon,
  PullRequestReviewOutcomeAvatarBadge,
  pullRequestReviewOutcomeLabel,
  PullRequestStateGlyph,
  pullRequestReviewOutcomeRingClassName,
  pullRequestReviewOutcomeStaleLabel,
} from "./pullRequestPresentation";
import { PullRequestReviewerPicker } from "./PullRequestReviewerPicker";

/** One reviewer, however a host happens to have cased their login this time. */
function reviewerKey(login: string): string {
  return login.toLowerCase();
}

/** "3s", "4m 12s", "1h 5m": how long a finished run took, where the host said. */
function checkDuration(check: PullRequestCheck): string | null {
  if (check.startedAt === undefined || check.completedAt === undefined) return null;
  const seconds = Math.round(
    (new Date(check.completedAt).getTime() - new Date(check.startedAt).getTime()) / 1000,
  );
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function ReadinessRow({
  icon,
  label,
  meta,
  children,
}: {
  icon: ReactNode;
  label: ReactNode;
  meta?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger render={<Button variant="ghost" size="sm" className="w-full" />}>
        <span className="flex min-w-0 flex-1 items-center gap-2 text-meta">
          {icon}
          <span className="min-w-0 flex-1 truncate text-left text-foreground">{label}</span>
          {meta ? <span className="shrink-0 truncate text-muted-foreground">{meta}</span> : null}
          <ChevronRightIcon
            aria-hidden
            className={cn(
              "size-3.5 shrink-0 text-dim-foreground transition-transform",
              open && "rotate-90",
            )}
          />
        </span>
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="px-2 pb-2 pl-7">{children}</div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

export function PullRequestReadinessCard({
  environmentId,
  threadRef,
  reference,
  detail,
  activityPending,
  checksState,
  checksStale,
  checksSummary,
  canApproveWorkflows,
  approvingWorkflows,
  approveWorkflows: {
    armed: approveWorkflowsArmed,
    ref: approveWorkflowsRef,
    onClick: onApproveWorkflows,
    onBlur: onApproveWorkflowsBlur,
  },
  onRefreshChecks,
  pendingFinding,
  fixCheckLabel,
  onFixFinding,
  mergeMethodLabel,
  freshness,
  actionPending,
  onUpdateBranch,
  resolveConflicts,
  primary,
  primaryMenu,
  primaryMenuVariant = "default",
  note,
}: {
  environmentId: EnvironmentId;
  threadRef: ScopedThreadRef | null;
  reference: PullRequestRef;
  detail: PullRequestDetailView;
  activityPending: boolean;
  checksState: PullRequestChecksState | null;
  checksStale: boolean;
  checksSummary: string | null;
  canApproveWorkflows: boolean;
  approvingWorkflows: boolean;
  /** The inline confirm for approving workflows: armed by the first click, run by the second. */
  approveWorkflows: {
    armed: boolean;
    ref?: RefCallback<HTMLElement> | undefined;
    onClick: (event: MouseEvent<HTMLElement>) => void;
    onBlur: () => void;
  };
  onRefreshChecks: () => void;
  pendingFinding: string | null;
  fixCheckLabel: string;
  onFixFinding?: ((finding: PullRequestFinding) => void) | undefined;
  /** The chosen strategy, lowercased beside the commit count on the conflicts row. */
  mergeMethodLabel: string | null;
  freshness: {
    readonly behindBy: number | null;
    readonly methods: ReadonlyArray<PullRequestUpdateMethod>;
  } | null;
  actionPending: boolean;
  onUpdateBranch: (method: PullRequestUpdateMethod) => void;
  /** The panel's own resolve-conflicts control, shown where the row says the branch conflicts. */
  resolveConflicts: ReactNode;
  /** The merge control, or the state that stands in its place. */
  primary: ReactNode;
  /** The split button's menu, when the primary is a button with more than one way to merge. */
  primaryMenu: ReactNode;
  /** The menu half matches the button it is welded to. */
  primaryMenuVariant?: "default" | "destructive-outline";
  /** A line under the merge control, such as an auto-merge that is already armed. */
  note?: ReactNode;
}) {
  const openLink = useOpenLink(threadRef);
  const openCheck = (url: string) => {
    void openLink(url).catch((error: unknown) => {
      console.error(error);
      toastManager.add({ type: "error", title: "Unable to open check details" });
    });
  };

  // Checks: the rollup's word leads, the count of what passed sits at the end of the row.
  const passed = detail.checks.filter(
    (check) =>
      check.status === "success" || check.status === "skipped" || check.status === "neutral",
  ).length;
  const checksPresentation = checksState ? pullRequestChecksStatePresentation(checksState) : null;
  const checksIcon =
    checksState === "pending" ? (
      <PullRequestCheckStatusIcon status="pending" />
    ) : checksPresentation ? (
      <checksPresentation.Icon
        aria-hidden
        className={cn("size-3.5 shrink-0", checksPresentation.toneClassName)}
      />
    ) : (
      <PullRequestCheckStatusIcon status="neutral" />
    );

  // Reviews: the same entries the reviewer row used to draw, now behind the approvals row.
  const reviewOutcomes = latestPullRequestReviewOutcomes(detail.comments, detail.commits);
  const outcomeByLogin = new Map(
    reviewOutcomes.flatMap((entry) =>
      entry.actor ? [[reviewerKey(entry.actor.login), entry] as const] : [],
    ),
  );
  const reviewerEntries = [
    ...detail.reviewers.map((actor) => ({
      key: actor.login,
      actor,
      outcome: outcomeByLogin.get(reviewerKey(actor.login))?.outcome ?? null,
      stale: outcomeByLogin.get(reviewerKey(actor.login))?.stale ?? false,
    })),
    ...reviewOutcomes
      .filter(
        (entry) =>
          !detail.reviewers.some(
            (actor) =>
              entry.actor !== null && reviewerKey(actor.login) === reviewerKey(entry.actor.login),
          ),
      )
      .map((entry) => ({
        key: entry.key,
        actor: entry.actor,
        outcome: entry.outcome,
        stale: entry.stale,
      })),
  ];
  const standing = reviewOutcomes.filter((entry) => !entry.stale);
  const changesRequested = standing.filter((entry) => entry.outcome === "changes-requested");
  const approved = standing.filter((entry) => entry.outcome === "approved");
  const names = (entries: typeof standing) => {
    const first = entries[0]?.actor?.login ?? "ghost";
    return entries.length > 1 ? `${first} and ${entries.length - 1} more` : first;
  };
  const reviewOutcome =
    changesRequested.length > 0
      ? ("changes-requested" as const)
      : approved.length > 0
        ? ("approved" as const)
        : null;
  const reviewLabel = activityPending
    ? "Reading reviews"
    : changesRequested.length > 0
      ? `Changes requested by ${names(changesRequested)}`
      : approved.length > 0
        ? `Approved by ${names(approved)}`
        : reviewerEntries.length > 0
          ? "Waiting on reviews"
          : "No reviews yet";
  const reviewMeta =
    activityPending || reviewerEntries.length === 0
      ? null
      : `${approved.length} of ${reviewerEntries.length} approved`;

  // Conflicts: only an open pull request has a merge to be in the way of.
  const open = detail.state === "open";
  const conflicting = open && detail.mergeability === "conflicting";
  const conflictsLabel = conflicting
    ? `Conflicts with ${detail.baseBranch}`
    : detail.mergeability === "unknown"
      ? `Checking for conflicts with ${detail.baseBranch}`
      : freshness
        ? `Behind ${detail.baseBranch}${
            freshness.behindBy === null
              ? ""
              : ` by ${freshness.behindBy.toLocaleString()} ${
                  freshness.behindBy === 1 ? "commit" : "commits"
                }`
          }`
        : `No conflicts with ${detail.baseBranch}`;
  const commitCount = activityPending
    ? null
    : `${detail.commits.length.toLocaleString()} ${detail.commits.length === 1 ? "commit" : "commits"}`;
  const conflictsMeta = [mergeMethodLabel, commitCount].filter(Boolean).join(" · ");

  return (
    <div className="surface-panel min-w-0 overflow-hidden rounded-xl p-1.5">
      <div className="space-y-1">
        {/* A finished pull request leads with how it ended; the rows below are its record. */}
        {open ? null : (
          <div className="flex min-h-8 min-w-0 items-center gap-2 px-2 text-meta">
            <PullRequestStateGlyph state={detail.state} isDraft={false} className="size-3.5" />
            <span className="min-w-0 flex-1 truncate text-foreground">
              {detail.state === "merged"
                ? `Merged into ${detail.baseBranch}`
                : "Closed without merging"}
            </span>
            {(detail.state === "merged" ? detail.mergedAt : detail.closedAt) ? (
              <span className="shrink-0 text-muted-foreground">
                <RelativeTime
                  timestamp={(detail.state === "merged" ? detail.mergedAt : detail.closedAt) ?? ""}
                />
              </span>
            ) : null}
          </div>
        )}
        <ReadinessRow
          icon={checksIcon}
          label={
            checksStale && checksPresentation
              ? checksPresentation.label
              : // Skipped and neutral runs count as passed here, as they do in the meta count.
                checksState === "passing"
                ? "All checks passed"
                : checksSummary
          }
          meta={
            checksStale || detail.checks.length === 0
              ? null
              : `${passed.toLocaleString()} of ${detail.checks.length.toLocaleString()}`
          }
        >
          {canApproveWorkflows ? (
            <Button
              size="xs"
              variant="warning-outline"
              disabled={actionPending}
              ref={approveWorkflowsRef}
              onClick={onApproveWorkflows}
              onBlur={onApproveWorkflowsBlur}
            >
              <PlayIcon aria-hidden className="size-3.5" />
              {approvingWorkflows
                ? "Approving..."
                : approveWorkflowsArmed
                  ? "Confirm approve?"
                  : "Approve workflows to run"}
            </Button>
          ) : null}
          {checksStale ? (
            <div className="flex items-center gap-2 text-meta text-muted-foreground">
              <span>Check details are out of date.</span>
              <Button size="xs" variant="ghost" onClick={onRefreshChecks}>
                Refresh
              </Button>
            </div>
          ) : detail.checks.length === 0 ? (
            <p className="text-meta text-muted-foreground">No checks reported.</p>
          ) : (
            detail.checks.map((check, index) => {
              const finding = { kind: "check", check } as const;
              const failing = check.status === "failure" || check.status === "cancelled";
              const duration = checkDuration(check);
              return (
                <div
                  // oxlint-disable-next-line react/no-array-index-key -- Check names and URLs can repeat; these status rows have no local state.
                  key={`${index}:${check.name}:${check.url ?? ""}`}
                  className="group -ml-2 flex items-center gap-2 rounded-md pr-1 hover:surface-ghost-hover"
                >
                  <button
                    type="button"
                    disabled={!check.url}
                    onClick={() => check.url && openCheck(check.url)}
                    className={cn(
                      "flex min-w-0 flex-1 text-left",
                      check.url ? "cursor-pointer" : "cursor-default",
                    )}
                  >
                    <span className="flex min-w-0 flex-1 items-start gap-2 px-2 py-1.5 text-meta leading-5 [&>svg]:mt-0.5">
                      <PullRequestCheckStatusIcon status={check.status} />
                      <span className="min-w-0 flex-1 wrap-anywhere">{check.name}</span>
                      <span className="shrink-0 tabular-nums text-muted-foreground">
                        {/* A skipped run still reports times, but "Skipped" is the answer there. */}
                        {duration && check.status !== "pending" && check.status !== "skipped"
                          ? duration
                          : pullRequestCheckStatusLabel(check)}
                      </span>
                    </span>
                  </button>
                  {/* Only where there is something to fix. */}
                  {onFixFinding && failing ? (
                    <Button
                      size="xs"
                      variant="ghost"
                      className="shrink-0"
                      disabled={pendingFinding !== null}
                      onClick={() => onFixFinding(finding)}
                    >
                      <HammerIcon className="size-3" />
                      {pendingFinding === pullRequestFindingKey(finding)
                        ? "Preparing..."
                        : fixCheckLabel}
                    </Button>
                  ) : null}
                </div>
              );
            })
          )}
        </ReadinessRow>

        <ReadinessRow
          icon={
            activityPending ? (
              <PullRequestCheckStatusIcon status="neutral" />
            ) : reviewOutcome ? (
              <PullRequestReviewOutcomeIcon outcome={reviewOutcome} />
            ) : (
              <PullRequestCheckStatusIcon status="skipped" />
            )
          }
          label={reviewLabel}
          meta={reviewMeta}
        >
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            {reviewerEntries.length === 0 ? (
              <span className="text-meta text-muted-foreground">Nobody has been asked yet.</span>
            ) : (
              reviewerEntries.map((entry) => {
                const verdict = entry.outcome
                  ? entry.stale
                    ? pullRequestReviewOutcomeStaleLabel(entry.outcome)
                    : pullRequestReviewOutcomeLabel(entry.outcome)
                  : "Pending";
                return (
                  <Tooltip key={entry.key}>
                    <TooltipTrigger
                      render={
                        <span className="inline-flex min-w-0 items-center gap-1.5 rounded-row px-1.5 py-1 text-meta" />
                      }
                    >
                      <span
                        className={cn(
                          "relative rounded-full",
                          entry.outcome
                            ? pullRequestReviewOutcomeRingClassName(entry.outcome, entry.stale)
                            : undefined,
                        )}
                      >
                        <PullRequestActorLabel
                          actor={entry.actor}
                          tooltip={false}
                          variant="avatar"
                        />
                        {entry.outcome ? (
                          <PullRequestReviewOutcomeAvatarBadge
                            outcome={entry.outcome}
                            stale={entry.stale}
                          />
                        ) : null}
                      </span>
                      <span className="truncate text-foreground">
                        {entry.actor?.login ?? "ghost"}
                      </span>
                      <span className="sr-only">{verdict}</span>
                    </TooltipTrigger>
                    <TooltipPopup side="bottom">{verdict}</TooltipPopup>
                  </Tooltip>
                );
              })
            )}
            {/* Shown wherever the host can take a review request at all, and disabled with the
                reason where this account may not make one. */}
            {detail.capabilities.reviewers.request &&
            detail.capabilities.reviewers.listCandidates ? (
              <PullRequestReviewerPicker
                environmentId={environmentId}
                reference={reference}
                allowed={detail.viewerPermissions.requestReviewers}
              />
            ) : null}
          </div>
          {detail.commentsTruncated ? (
            <p className="mt-1 text-meta text-muted-foreground">
              Only the recent conversation was read, so older reviews may be missing here.
            </p>
          ) : null}
        </ReadinessRow>

        {open ? (
          <ReadinessRow
            icon={
              conflicting ? (
                <PullRequestGlyph.conflicting
                  aria-hidden
                  className="size-3.5 shrink-0 text-destructive"
                />
              ) : detail.mergeability === "unknown" ? (
                <PullRequestCheckStatusIcon status="pending" />
              ) : freshness ? (
                <PullRequestCheckStatusIcon status="action-required" />
              ) : (
                <PullRequestCheckStatusIcon status="success" />
              )
            }
            label={conflictsLabel}
            meta={conflictsMeta.length > 0 ? conflictsMeta : null}
          >
            {conflicting ? (
              <div className="flex flex-wrap items-center gap-2 text-meta text-muted-foreground">
                <span>These changes conflict with {detail.baseBranch}.</span>
                {resolveConflicts}
              </div>
            ) : freshness ? (
              <div className="flex flex-wrap items-center gap-1.5 text-meta text-muted-foreground">
                <span className="w-full">Changes can be cleanly merged.</span>
                {freshness.methods.map((method) => (
                  <Button
                    key={method}
                    size="xs"
                    variant="secondary"
                    disabled={actionPending}
                    onClick={() => onUpdateBranch(method)}
                  >
                    <PullRequestGlyph.merged aria-hidden className="size-3" />
                    {method === "rebase" ? "Update with rebase" : "Update branch"}
                  </Button>
                ))}
              </div>
            ) : (
              <p className="text-meta text-muted-foreground">
                {detail.mergeability === "unknown"
                  ? "The host is still working out whether this merges cleanly."
                  : "Changes can be cleanly merged."}
              </p>
            )}
          </ReadinessRow>
        ) : null}
      </div>
      {primary ? (
        <div className="px-2 pt-3 pb-2">
          <div className="flex min-w-0 items-stretch">
            {primaryMenu ? (
              <Group className="w-full">
                {primary}
                <Menu>
                  <MenuTrigger
                    render={
                      <Button
                        size="icon-sm"
                        variant={primaryMenuVariant}
                        aria-label="More merge actions"
                      />
                    }
                  >
                    <ChevronDownIcon aria-hidden className="size-3.5" />
                  </MenuTrigger>
                  <MenuPopup align="end" side="bottom">
                    {primaryMenu}
                  </MenuPopup>
                </Menu>
              </Group>
            ) : (
              primary
            )}
          </div>
          {note ? <div className="mt-2 text-meta text-muted-foreground">{note}</div> : null}
        </div>
      ) : null}
    </div>
  );
}
