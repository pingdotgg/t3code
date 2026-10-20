import { PullRequestChangeBreakdownRows } from "../pullRequest/PullRequestChangeBreakdownStat";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { selectEnvironmentQueryData } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ProjectId, PullRequestRef } from "@t3tools/contracts";
import { sourceControlRepositorySelector } from "@t3tools/shared/sourceControl";
import {
  ArrowUpRightIcon,
  EyeIcon,
  EyeOffIcon,
  FileDiffIcon,
  GitBranchIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { AsyncResult } from "effect/reactivity";
import { useState, type MouseEvent as ReactMouseEvent } from "react";

import { useLiveRefresh } from "~/hooks/useLiveRefresh";
import { usePullRequestChecksRefresh } from "~/hooks/usePullRequestChecksRefresh";
import { cn } from "~/lib/utils";
import { useServerConfigs } from "~/state/entities";
import { pullRequestEnvironment } from "~/state/pullRequests";
import {
  useEnvironmentQueryIsNewer,
  useEnvironmentQueryRefresh,
  useEnvironmentQuerySelector,
} from "~/state/query";

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
import { PullRequestChecksPopover } from "../pullRequest/PullRequestChecksPopover";
import {
  pullRequestChecksState,
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
  THREAD_DETAILS_PANEL_LABEL_CLASS,
  THREAD_DETAILS_PANEL_SPLIT_GROUP_CLASS,
  THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS,
} from "./threadDetailsPanelStyles";

// A server without checks for this pull request answers null; polling it again finds nothing new.
const isSettledWithoutChecks = (result: AsyncResult.AsyncResult<unknown, unknown>) =>
  result._tag === "Success" && result.value === null;

export function ThreadDetailsPrRow({
  environmentId,
  pr,
  number,
  reference: linkedReference,
  status,
  project,
  label,
  openAriaLabel,
  onOpen,
  onActed,
  onStopWatching,
}: {
  environmentId: EnvironmentId;
  pr: ThreadPr;
  number: number;
  reference?: Pick<PullRequestRef, "host" | "repository" | "number"> | null;
  status: PrStatusIndicator | null;
  project: EnvironmentProject | null;
  label: string;
  openAriaLabel: string;
  onOpen: (event: ReactMouseEvent<HTMLElement>) => void;
  onActed?: () => void;
  onStopWatching?: (() => void) | undefined;
}) {
  const serverConfigs = useServerConfigs();
  const supportsPullRequests =
    serverConfigs.get(environmentId)?.environment.capabilities.pullRequests === true;
  const repository = sourceControlRepositorySelector(project?.repositoryIdentity);
  const reference: PullRequestRef | null =
    supportsPullRequests && project !== null
      ? linkedReference
        ? { ...linkedReference, projectId: project.id as ProjectId }
        : repository !== null
          ? { projectId: project.id as ProjectId, repository, number }
          : null
      : null;
  const detailAtom =
    reference === null
      ? null
      : pullRequestEnvironment.detail({
          environmentId,
          input: { ...reference, allowStale: false },
        });
  // Read the queries part by part: every poll publishes a new result (a new
  // timestamp, `waiting` on and off) even when nothing in it changed.
  const detailData = useEnvironmentQuerySelector(detailAtom, selectEnvironmentQueryData);
  const detailQuery = useEnvironmentQueryRefresh(detailAtom);
  const supportsChecks =
    serverConfigs.get(environmentId)?.environment.capabilities.pullRequestChecks === true;
  const checksAtom =
    supportsChecks && reference !== null && detailData !== null
      ? pullRequestEnvironment.checks({ environmentId, input: reference })
      : null;
  const checksData = useEnvironmentQuerySelector(checksAtom, selectEnvironmentQueryData);
  const checksSettledEmpty = useEnvironmentQuerySelector(checksAtom, isSettledWithoutChecks);
  const checksQuery = useEnvironmentQueryRefresh(checksAtom);
  const checksAreNewer = useEnvironmentQueryIsNewer(checksAtom, detailAtom);
  const detail =
    detailData === null
      ? null
      : checksData !== null && checksAreNewer
        ? { ...detailData, ...checksData }
        : detailData;
  const open = reference !== null && (detail?.state ?? pr?.state) === "open";
  const refreshKey = `${environmentId}:${project?.id}:${reference?.host}:${reference?.repository}:${number}`;
  useLiveRefresh(
    () => {
      if (!detailQuery.isPending()) detailQuery.refresh();
    },
    { enabled: open, key: `workspace-pr:${refreshKey}`, intervalMs: 10 * 60_000 },
  );
  usePullRequestChecksRefresh({
    refresh: () => {
      if (!checksQuery.isPending() && !detailQuery.isPending()) checksQuery.refresh();
    },
    enabled: open && supportsChecks && !checksSettledEmpty,
    key: `workspace-pr-checks:${refreshKey}`,
    checks: detail?.checks ?? [],
  });

  const { actionPending, perform } = usePullRequestActionRunner({
    environmentId,
    reference,
    onSuccess: () => {
      detailQuery.refresh();
      checksQuery.refresh();
      onActed?.();
    },
  });
  const { handoff, startHandoff } = usePullRequestHandoffs({ environmentId, detail });
  const [confirmingMerge, setConfirmingMerge] = useState(false);

  const rowAction = resolveThreadPanelPullRequestAction(detail);
  if (confirmingMerge && rowAction !== "merge") {
    setConfirmingMerge(false);
  }
  const conflicting = isPullRequestConflicting(detail);
  const checksState = detail === null ? "none" : classifyPullRequestChecks(detail.checks);
  const checksRollup = detail === null ? null : pullRequestChecksState(detail.checks);
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

  const statePresentation =
    detail === null
      ? null
      : resolvePullRequestState({
          state: detail.state,
          isDraft: detail.isDraft,
        });
  const icon = statePresentation ? (
    <statePresentation.Icon
      aria-hidden
      className={cn("size-4 shrink-0", statePresentation.toneClassName)}
    />
  ) : pr && status ? (
    <ChangeRequestStatusIcon
      state={pr.state}
      className={cn(THREAD_DETAILS_PANEL_ICON_CLASS, status.colorClass)}
    />
  ) : (
    <PullRequestGlyph.pullRequest className={THREAD_DETAILS_PANEL_ICON_CLASS} />
  );

  const rowTooltip =
    detail === null || statePresentation === null ? (
      <TooltipPopup side="top">{status?.tooltip ?? `Pull request #${number}`}</TooltipPopup>
    ) : (
      <TooltipPopup
        side="top"
        align="start"
        sideOffset={4}
        variant="glass"
        className="max-w-80 text-left whitespace-normal"
      >
        <div className="flex min-w-0 max-w-80 flex-col gap-2 px-1 py-2">
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
                <div className="min-w-0 flex-1 wrap-break-word">
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
            {reference !== null && (detail.additions > 0 || detail.deletions > 0) ? (
              <PullRequestChangeBreakdownRows
                environmentId={environmentId}
                reference={reference}
                className="pl-5 text-foreground/75"
              />
            ) : null}
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

  const watching =
    onStopWatching !== undefined && (detail?.state ?? pr?.state ?? "open") === "open";
  const watchControl = (part: "secondary" | "icon") =>
    watching ? (
      <Tooltip>
        <TooltipTrigger
          render={
            <ThreadDetailsControl
              type="button"
              variant="ghost"
              size="sm"
              part={part}
              className="group/watch"
              aria-label={`Stop watching #${number}`}
              onClick={onStopWatching}
            />
          }
        >
          <EyeIcon
            aria-hidden
            className={cn(part === "icon" ? "size-3.5" : "size-4", "group-hover/watch:hidden")}
          />
          <EyeOffIcon
            aria-hidden
            className={cn(
              part === "icon" ? "size-3.5" : "size-4",
              "hidden group-hover/watch:block",
            )}
          />
        </TooltipTrigger>
        <TooltipPopup side="top">
          Watching: the agent wakes when checks finish, someone comments, or the branch conflicts.
          Click to stop.
        </TooltipPopup>
      </Tooltip>
    ) : null;

  const openRow = (text: string, part: "row" | "primary") => (
    <Tooltip>
      <TooltipTrigger
        render={
          <ThreadDetailsControl
            type="button"
            variant="ghost"
            size="sm"
            part={part}
            aria-label={openAriaLabel}
            onClick={onOpen}
            onAuxClick={onOpen}
          />
        }
      >
        {icon}
        <span className={cn("min-w-0 flex-1 truncate text-left", THREAD_DETAILS_PANEL_LABEL_CLASS)}>
          {text}
        </span>
      </TooltipTrigger>
      {rowTooltip}
    </Tooltip>
  );

  const showChecks = detail !== null && checksRollup !== null && !conflicting && !detail.isDraft;

  return (
    <>
      {detail !== null && (showChecks || trailingAction !== null || watching) ? (
        <div className="pb-2">
          {openRow(detail.title, "row")}
          <div className="-mt-1 flex h-6 min-w-0 items-center gap-0.5 ps-9 pe-1 text-xs text-muted-foreground">
            <span className="me-1 shrink-0 tabular-nums">#{number}</span>
            {showChecks && checksRollup !== null ? (
              <PullRequestChecksPopover
                checksState={checksRollup}
                checks={detail.checks}
                variant="count"
                render={<ThreadDetailsControl part="meta" />}
              />
            ) : null}
            {watchControl("icon")}
            <span className="flex-1" />
            {trailingAction ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <ThreadDetailsControl
                      type="button"
                      variant="ghost"
                      size="sm"
                      part="meta"
                      tone={trailingAction.destructive ? "destructive" : "primary"}
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
            ) : null}
          </div>
        </div>
      ) : watching ? (
        <div className={THREAD_DETAILS_PANEL_SPLIT_GROUP_CLASS}>
          {openRow(label, "primary")}
          <span aria-hidden="true" className={THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS} />
          {watchControl("secondary")}
        </div>
      ) : (
        openRow(label, "row")
      )}
      {rowAction === "merge" ? (
        <AlertDialog open={confirmingMerge} onOpenChange={(open) => setConfirmingMerge(open)}>
          <AlertDialogPopup>
            <AlertDialogHeader>
              <AlertDialogTitle>Merge pull request?</AlertDialogTitle>
              <AlertDialogDescription>
                This merges #{number} using {selectedMergeMethod}.
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
