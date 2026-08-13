/**
 * The thread details panel's pull request row: what the branch's pull request is, and the one
 * thing worth doing to it right now.
 *
 * The row itself opens the pull request in the right panel, exactly as it always has. Around
 * that, the host's richer answer collapses into a single trailing slot, ranked by what unblocks
 * the merge next: "Resolve" on conflicts, "Ready" on a draft, "Fix" under failing checks, and
 * "Merge" only once the branch is clean and its checks pass. While checks run the slot reports
 * that instead — a merge offered mid-run would race the very runs that gate it. Everything else
 * the host knows (title, state, checks tally, diff size) lives in the row's tooltip, so a hover
 * answers what previously took opening the panel.
 *
 * Until the detail arrives — or where pull requests are not supported at all — the row renders
 * from the `vcs.status` summary alone, which is the plain row this panel showed before.
 */
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ProjectId, PullRequestRef } from "@t3tools/contracts";
import { ArrowUpRightIcon, FileDiffIcon, GitBranchIcon, TriangleAlertIcon } from "lucide-react";
import { useState, type MouseEvent as ReactMouseEvent } from "react";

import { cn } from "~/lib/utils";
import { useServerConfigs } from "~/state/entities";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";

import {
  buildFixFindingsHandoff,
  buildResolveConflictsPrompt,
  classifyPullRequestChecks,
  describePullRequestChecks,
  isPullRequestConflicting,
  resolveSelectedMergeMethod,
  allowedPullRequestMergeMethods,
  resolveThreadPanelPullRequestAction,
} from "../pullRequest/pullRequestDetail.logic";
import {
  PullRequestCheckStatusIcon,
  PullRequestDiffStat,
  resolvePullRequestState,
} from "../pullRequest/pullRequestPresentation";
import {
  usePullRequestActionRunner,
  usePullRequestHandoffs,
} from "../pullRequest/usePullRequestActions";
import {
  ChangeRequestStatusIcon,
  type PrStatusIndicator,
  type ThreadPr,
} from "../ThreadStatusIndicators";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LINK_SPLIT_ACTION_CLASS,
  THREAD_DETAILS_PANEL_LINK_SPLIT_GROUP_CLASS,
  THREAD_DETAILS_PANEL_LINK_SPLIT_PRIMARY_CLASS,
  THREAD_DETAILS_PANEL_ROW_CLASS,
  THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS,
} from "./threadDetailsPanelStyles";

export function ThreadDetailsPrRow({
  environmentId,
  pr,
  status,
  project,
  label,
  openAriaLabel,
  onOpen,
  onActed,
}: {
  environmentId: EnvironmentId;
  pr: NonNullable<ThreadPr>;
  status: PrStatusIndicator;
  /** The thread's project, which is what the pull request is read through on the host. */
  project: EnvironmentProject | null;
  label: string;
  openAriaLabel: string;
  onOpen: (event: ReactMouseEvent<HTMLElement>) => void;
  /** An action changed the pull request on the host, so the vcs status behind the row is stale. */
  onActed?: () => void;
}) {
  const serverConfigs = useServerConfigs();
  const supportsPullRequests =
    serverConfigs.get(environmentId)?.environment.capabilities.pullRequests === true;
  // The identity's own spelling, the way the detail panel is addressed everywhere else.
  const identity = project?.repositoryIdentity;
  const repository =
    identity?.displayName ??
    (identity?.owner && identity.name ? `${identity.owner}/${identity.name}` : null);
  const reference: PullRequestRef | null =
    supportsPullRequests && project !== null && repository !== null
      ? { projectId: project.id as ProjectId, repository, number: pr.number }
      : null;
  const detailQuery = useEnvironmentQuery(
    reference === null ? null : pullRequestEnvironment.detail({ environmentId, input: reference }),
  );
  const detail = detailQuery.data ?? null;

  const { actionPending, perform } = usePullRequestActionRunner({
    environmentId,
    reference,
    onSuccess: () => {
      detailQuery.refresh();
      onActed?.();
    },
  });
  const { handoff, startHandoff } = usePullRequestHandoffs({ environmentId, detail });
  const [confirmingMerge, setConfirmingMerge] = useState(false);

  const rowAction = resolveThreadPanelPullRequestAction(detail);
  const conflicting = isPullRequestConflicting(detail);
  const checksState = detail === null ? "none" : classifyPullRequestChecks(detail.checks);
  const checksRunning = detail?.state === "open" && rowAction === null && checksState === "pending";
  const selectedMergeMethod = resolveSelectedMergeMethod(
    allowedPullRequestMergeMethods(detail),
    "merge",
  );

  const startResolveConflicts = () => {
    if (detail === null) return;
    void startHandoff("conflicts", {
      prompt: buildResolveConflictsPrompt({
        number: detail.number,
        url: detail.url,
        headBranch: detail.headBranch,
        baseBranch: detail.baseBranch,
      }),
    });
  };

  const startFixChecks = () => {
    if (detail === null) return;
    // The compact row fetches no conversation, so the handoff carries the failing checks alone;
    // review threads keep arriving through the full panel's richer version of this action.
    void startHandoff(
      "findings",
      buildFixFindingsHandoff({
        number: detail.number,
        title: detail.title,
        url: detail.url,
        headBranch: detail.headBranch,
        baseBranch: detail.baseBranch,
        reviewThreads: [],
        comments: [],
        checks: detail.checks,
        commentsTruncated: false,
      }),
    );
  };

  // Once the host has answered, the glyph knows about drafts and conflicts, which the vcs
  // summary does not. Draft outranks conflicts in it, same as the detail panel.
  const statePresentation =
    detail === null
      ? null
      : resolvePullRequestState({
          state: detail.state,
          isDraft: detail.isDraft,
          mergeability: detail.mergeability,
          baseBranch: detail.baseBranch,
        });
  const icon = statePresentation ? (
    <statePresentation.Icon
      aria-hidden
      className={cn("-mx-0.5 size-4 shrink-0", statePresentation.toneClassName)}
    />
  ) : (
    <ChangeRequestStatusIcon className={cn(THREAD_DETAILS_PANEL_ICON_CLASS, status.colorClass)} />
  );

  // Everything the host reported, at a glance. The row stays one line; the tooltip is where the
  // rest of the answer lives — styled like the sidebar's thread tooltip, title above icon-led
  // detail rows, so the two read as one family.
  const rowTooltip =
    detail === null || statePresentation === null ? (
      <TooltipPopup side="top">{status.tooltip}</TooltipPopup>
    ) : (
      <TooltipPopup
        side="top"
        align="start"
        sideOffset={4}
        variant="glass"
        className="max-w-80 text-left whitespace-normal [&_[data-slot=tooltip-viewport]]:p-0"
      >
        <div className="flex min-w-0 max-w-80 flex-col gap-2 p-[var(--floating-content-inset)]">
          <div className="flex min-w-0 items-baseline gap-1.5 text-xs leading-none">
            <span className="min-w-0 truncate font-medium text-foreground">{detail.title}</span>
            <span className="shrink-0 text-muted-foreground">#{detail.number}</span>
          </div>
          <div className="grid gap-1.5 pl-0.5 text-xs text-muted-foreground">
            <div className="flex min-w-0 items-center gap-2">
              <statePresentation.Icon
                aria-hidden
                className={cn("size-3 shrink-0", statePresentation.toneClassName)}
              />
              <div className="min-w-0 truncate text-foreground/75">{statePresentation.label}</div>
            </div>
            <div className="flex min-w-0 items-center gap-2">
              <GitBranchIcon className="size-3 shrink-0 stroke-muted-foreground" />
              <div className="min-w-0 truncate text-foreground/75">
                {detail.baseBranch} ← {detail.headBranch}
              </div>
            </div>
            {detail.state === "open" && checksState !== "none" ? (
              <div className="flex min-w-0 items-center gap-2">
                <PullRequestCheckStatusIcon
                  status={
                    checksState === "failing"
                      ? "failure"
                      : checksState === "pending"
                        ? "pending"
                        : "success"
                  }
                />
                <div className="min-w-0 truncate text-foreground/75">
                  {describePullRequestChecks(detail.checks)}
                </div>
              </div>
            ) : null}
            {detail.isDraft && conflicting ? (
              <div className="flex min-w-0 items-start gap-2 text-destructive">
                <TriangleAlertIcon aria-hidden className="mt-0.5 size-3 shrink-0 stroke-current" />
                <div className="min-w-0 flex-1 wrap-break-word leading-5">
                  Merge conflicts with {detail.baseBranch}
                </div>
              </div>
            ) : null}
            <div className="flex min-w-0 items-center gap-2">
              <FileDiffIcon className="size-3 shrink-0 stroke-muted-foreground" />
              <div className="min-w-0 flex items-baseline gap-1 truncate text-foreground/75">
                {detail.changedFiles.toLocaleString()}{" "}
                {detail.changedFiles === 1 ? "file" : "files"}
                <PullRequestDiffStat additions={detail.additions} deletions={detail.deletions} />
              </div>
            </div>
          </div>
        </div>
      </TooltipPopup>
    );

  const trailingAction =
    rowAction === "resolve"
      ? {
          label: "Resolve",
          pendingLabel: "Preparing...",
          pending: handoff === "conflicts",
          destructive: true,
          suffix: <ArrowUpRightIcon aria-hidden className="size-3 shrink-0" />,
          tooltip: "Check the branch out and resolve the conflicts in a new thread",
          onClick: startResolveConflicts,
        }
      : rowAction === "ready"
        ? {
            label: "Ready",
            pendingLabel: "Marking...",
            pending: actionPending,
            destructive: false,
            suffix: null,
            tooltip: "Mark this pull request as ready for review",
            onClick: () => void perform("ready"),
          }
        : rowAction === "fix"
          ? {
              label: "Fix",
              pendingLabel: "Preparing...",
              pending: handoff === "findings",
              destructive: true,
              suffix: <ArrowUpRightIcon aria-hidden className="size-3 shrink-0" />,
              tooltip: "Fix the failing checks in a new thread",
              onClick: startFixChecks,
            }
          : rowAction === "merge"
            ? {
                label: "Merge",
                pendingLabel: "Merging...",
                pending: actionPending,
                destructive: false,
                suffix: null,
                tooltip: `Merge this pull request (${selectedMergeMethod})`,
                onClick: () => setConfirmingMerge(true),
              }
            : null;

  const rowContent = (
    <>
      {icon}
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
    </>
  );

  return (
    <>
      {trailingAction || checksRunning ? (
        <div className={THREAD_DETAILS_PANEL_LINK_SPLIT_GROUP_CLASS}>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className={THREAD_DETAILS_PANEL_LINK_SPLIT_PRIMARY_CLASS}
                  aria-label={openAriaLabel}
                  onClick={onOpen}
                />
              }
            >
              {rowContent}
            </TooltipTrigger>
            {rowTooltip}
          </Tooltip>
          <span aria-hidden="true" className={THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS} />
          {trailingAction ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className={cn(
                      THREAD_DETAILS_PANEL_LINK_SPLIT_ACTION_CLASS,
                      trailingAction.destructive &&
                        "text-destructive hover:text-destructive data-pressed:text-destructive",
                    )}
                    disabled={actionPending || handoff !== null}
                    onClick={trailingAction.onClick}
                  />
                }
              >
                {trailingAction.pending ? trailingAction.pendingLabel : trailingAction.label}
                {trailingAction.suffix}
              </TooltipTrigger>
              <TooltipPopup side="top">{trailingAction.tooltip}</TooltipPopup>
            </Tooltip>
          ) : (
            // Checks are still running: the slot reports that instead of offering a merge that
            // would race them. Not a button — there is nothing to press until they finish.
            <Tooltip>
              <TooltipTrigger
                render={
                  <span className="flex h-9 shrink-0 cursor-default items-center gap-1.5 px-2.5 text-[13px] font-medium text-muted-foreground" />
                }
              >
                <PullRequestCheckStatusIcon status="pending" />
                <span className="tabular-nums">
                  {detail === null
                    ? null
                    : `${detail.checks.filter((check) => check.status === "pending").length}/${detail.checks.length}`}
                </span>
              </TooltipTrigger>
              <TooltipPopup side="top">
                {detail ? describePullRequestChecks(detail.checks) : "Checks are running"}
              </TooltipPopup>
            </Tooltip>
          )}
        </div>
      ) : (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className={THREAD_DETAILS_PANEL_ROW_CLASS}
                aria-label={openAriaLabel}
                onClick={onOpen}
              />
            }
          >
            {rowContent}
          </TooltipTrigger>
          {rowTooltip}
        </Tooltip>
      )}
      {rowAction === "merge" ? (
        <AlertDialog open={confirmingMerge} onOpenChange={(open) => setConfirmingMerge(open)}>
          <AlertDialogPopup>
            <AlertDialogHeader>
              <AlertDialogTitle>Merge pull request?</AlertDialogTitle>
              <AlertDialogDescription>
                This merges #{pr.number} using {selectedMergeMethod}.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogClose render={<Button variant="outline" size="sm" />}>
                Cancel
              </AlertDialogClose>
              <Button
                size="sm"
                disabled={actionPending}
                onClick={() => {
                  setConfirmingMerge(false);
                  void perform("merge", selectedMergeMethod);
                }}
              >
                Merge
              </Button>
            </AlertDialogFooter>
          </AlertDialogPopup>
        </AlertDialog>
      ) : null}
    </>
  );
}
