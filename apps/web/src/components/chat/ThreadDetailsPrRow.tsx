/**
 * The thread details panel's pull request row: what the branch's pull request is, and the one
 * thing worth doing to it right now.
 *
 * The row itself opens the pull request in the right panel, exactly as it always has. Around
 * that, the host's richer answer — draft, mergeable, conflicting — turns into at most one
 * trailing action ("Ready" on a clean draft, "Merge" on a mergeable branch) and a conflict line
 * below when the branch cannot merge. All of it runs through the same hooks as the detail panel,
 * so the row can never offer something the panel would refuse.
 *
 * Until the detail arrives — or where pull requests are not supported at all — the row renders
 * from the `vcs.status` summary alone, which is the plain row this panel showed before.
 */
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ProjectId, PullRequestRef } from "@t3tools/contracts";
import { ArrowUpRightIcon, TriangleAlertIcon } from "lucide-react";
import { useState, type MouseEvent as ReactMouseEvent } from "react";

import { cn } from "~/lib/utils";
import { useServerConfigs } from "~/state/entities";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";

import {
  allowedPullRequestMergeMethods,
  buildResolveConflictsPrompt,
  isPullRequestConflicting,
  resolvePullRequestPrimaryAction,
  resolveSelectedMergeMethod,
} from "../pullRequest/pullRequestDetail.logic";
import { resolvePullRequestState } from "../pullRequest/pullRequestPresentation";
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

  const primaryAction = resolvePullRequestPrimaryAction(detail);
  const conflicting = isPullRequestConflicting(detail);
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

  // Once the host has answered, the glyph knows about drafts, which the vcs summary does not.
  const statePresentation =
    detail === null
      ? null
      : resolvePullRequestState({ state: detail.state, isDraft: detail.isDraft });
  const icon = statePresentation ? (
    <statePresentation.Icon
      aria-hidden
      className={cn("-mx-0.5 size-4 shrink-0", statePresentation.toneClassName)}
    />
  ) : (
    <ChangeRequestStatusIcon className={cn(THREAD_DETAILS_PANEL_ICON_CLASS, status.colorClass)} />
  );

  const trailingAction =
    primaryAction === "ready"
      ? {
          label: "Ready",
          pendingLabel: "Marking...",
          tooltip: "Mark this pull request as ready for review",
          onClick: () => void perform("ready"),
        }
      : primaryAction === "merge"
        ? {
            label: "Merge",
            pendingLabel: "Merging...",
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
      {trailingAction ? (
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
            <TooltipPopup side="top">{status.tooltip}</TooltipPopup>
          </Tooltip>
          <span aria-hidden="true" className={THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS} />
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className={THREAD_DETAILS_PANEL_LINK_SPLIT_ACTION_CLASS}
                  disabled={actionPending}
                  onClick={trailingAction.onClick}
                />
              }
            >
              {actionPending ? trailingAction.pendingLabel : trailingAction.label}
            </TooltipTrigger>
            <TooltipPopup side="top">{trailingAction.tooltip}</TooltipPopup>
          </Tooltip>
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
          <TooltipPopup side="top">{status.tooltip}</TooltipPopup>
        </Tooltip>
      )}
      {conflicting ? (
        // The same words the detail panel says, one click away, so the two read as one thing.
        <div className="flex h-8 items-center gap-1.5 ps-2.5 pe-1">
          <TriangleAlertIcon aria-hidden className="size-3.5 shrink-0 text-destructive" />
          <span className="min-w-0 truncate text-xs font-medium text-destructive">
            Merge conflicts
          </span>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="xs"
                  variant="ghost"
                  className="ml-auto h-6 shrink-0 gap-1 px-1.5 text-xs text-destructive hover:bg-destructive/8 hover:text-destructive"
                  disabled={handoff !== null}
                  onClick={startResolveConflicts}
                />
              }
            >
              {handoff === "conflicts" ? "Preparing..." : "Resolve"}
              <ArrowUpRightIcon aria-hidden className="size-3 text-destructive" />
            </TooltipTrigger>
            <TooltipPopup side="top">
              Check the branch out and resolve the conflicts in a new thread
            </TooltipPopup>
          </Tooltip>
        </div>
      ) : null}
      {primaryAction === "merge" ? (
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
