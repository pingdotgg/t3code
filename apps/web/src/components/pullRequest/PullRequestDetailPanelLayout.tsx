import {
  ArrowDownUpIcon,
  ArrowLeftIcon,
  CircleDotIcon,
  FileDiffIcon,
  GitCommitHorizontalIcon,
  MessageSquareIcon,
  PanelRightIcon,
} from "lucide-react";
import { Suspense } from "react";

import { cn } from "~/lib/utils";

import { PullRequestStackMenu } from "./PullRequestStackMenu";
import { PullRequestChangeBreakdownStat } from "./PullRequestChangeBreakdownStat";
import {
  capitalizeTerm,
  sourceControlClients,
} from "@t3tools/client-runtime/source-control-clients";
import { PullRequestThreadLinks } from "./PullRequestThreadLinks";

import { RelativeTime } from "~/components/RelativeTime";

import { Button } from "../ui/button";

import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "../ui/tooltip";
import { MiddleTruncate } from "../ui/middle-truncate";
import {
  PullRequestChecksStatusLine,
  PullRequestDetailHeaderBody,
  PullRequestDetailTabBar,
} from "./PullRequestDetailLayout";
import { PullRequestTimelineGhost } from "./PullRequestGhosts";
import { PullRequestCopyableCode } from "./PullRequestCopyableCode";

import { PullRequestActionsMenu } from "./PullRequestActionsMenu";
import {
  PullRequestApproveWorkflowsButton,
  PullRequestPrimaryAction,
} from "./PullRequestDetailActions";
import { PullRequestBaseBranch } from "./PullRequestBaseBranch";
import { PullRequestDetailCrumbs } from "./PullRequestDetailCrumbs";
import { PullRequestTitleEditor } from "./PullRequestTitleEditor";
import { PullRequestActivityUnavailableState } from "./PullRequestActivityUnavailableState";
import { SourceControlAppAccessNotice } from "../SourceControlAppAccessNotice";
import { DiffPanelLoadingState } from "../DiffPanelShell";
import { PullRequestsUnavailableState } from "./PullRequestsUnavailableState";

import { openOnHostLabel } from "./pullRequestLinkContextMenu";
import { PullRequestMarkdownContext } from "./PullRequestMarkdown";

import { PullRequestComposer } from "./PullRequestComposer";
import { PullRequestSummaryTab } from "./PullRequestSummaryTab";
import { PullRequestTimelineTab } from "./PullRequestTimelineTab";
import { isPullRequestNotFound } from "./pullRequestDetail.logic";

import { PullRequestChecksPopover } from "./PullRequestChecksPopover";
import {
  PullRequestActorLabel,
  PullRequestMetaLine,
  PullRequestReviewOutcomeIcon,
  pullRequestReviewOutcomeToneClassName,
} from "./pullRequestPresentation";
import { PullRequestGuideTab } from "./PullRequestGuideTab";

import {
  PullRequestCodeTab,
  loadCodeTab,
  reportCheckoutCommandError,
} from "./pullRequestDetailPanelShared";

import type { PullRequestDetailPanelState } from "./usePullRequestDetailPanelControls";

/** Everything the detail panel renders, once its hooks have resolved what applies. */
export function PullRequestDetailPanelLayout({ state }: { state: PullRequestDetailPanelState }) {
  const {
    actingEnvironmentId,
    actionPending,
    activityError,
    activityPending,
    activityQuery,
    addSelectionToAgent,
    allowedMergeMethods,
    approvalCount,
    armedAutoMergeLabel,
    askAboutGuideStop,
    askAboutPullRequest,
    attachTarget,
    authorProfileUrl,
    autoMergeArmed,
    can,
    canFixFindings,
    canWriteSourceControl,
    checkoutCommand,
    checkoutControl,
    checksStale,
    checksState,
    checksSummary,
    codeRevealRequest,
    compensationRef,
    composerDraftTarget,
    condensed,
    condensedByTab,
    condensedRowRef,
    confirmDeleteBranch,
    context,
    copyReference,
    detail,
    detailQuery,
    environmentConnected,
    environmentId,
    explainPullRequest,
    foldRef,
    freshness,
    guideKey,
    guideWriter,
    handoff,
    handoffLabels,
    hostClient,
    isStackedPullRequest,
    markdownContext,
    mergeBlockedReason,
    mountedTabs,
    nativeStack,
    nativeStackQuery,
    onActed,
    onBack,
    onClose,
    onGuideShown,
    onSelectPullRequest,
    openCommit,
    openFileInCode,
    openOnHostText,
    openReviewRequest,
    pendingAction,
    pendingAutoMergeLabel,
    perform,
    performCommentAction,
    pickableEnvironments,
    primaryAction,
    pullRequestKey,
    reference,
    refreshDetail,
    refreshFromHost,
    refreshToken,
    refreshing,
    repositoryIdentity,
    repositoryUrl,
    resolveConflictsControl,
    reviewGuidesEnabled,
    scrollerByTab,
    scrollerRefs,
    selectActingEnvironment,
    selectCodeCommit,
    selectMergeMethod,
    selectTab,
    selectedCodeCommitOid,
    selectedMergeMethod,
    selectedMergeMethodLabel,
    setCondensedByTab,
    setOpenReviewRequest,
    setThreadPickerOpen,
    setTimelineOrder,
    showsApproveWorkflows,
    showsAutoMerge,
    showsDeleteBranch,
    showsDraftToggle,
    showsMergeMethods,
    showsMergeNow,
    startFixFinding,
    startFixFindings,
    statePresentation,
    supportsStackActions,
    tab,
    terminology,
    threadPickerOpen,
    threadRef,
    timelineOrder,
    turnRefresh,
    unavailableHostUrl,
    visibleTabs,
    writeGuide,
  } = state;
  return (
    <div className="relative flex h-full min-h-0 w-full flex-col bg-background">
      {threadPickerOpen && detail ? (
        <PullRequestThreadLinks
          key={`${environmentId}:${detail.url}`}
          display="picker"
          environmentId={environmentId}
          reference={reference}
          url={detail.url}
          threadRef={null}
          onPickerOpenChange={setThreadPickerOpen}
        />
      ) : null}
      <div
        className={cn(
          "@container/pr-header grid min-w-0 shrink-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-x-2",
          detail && "border-b border-border/60",
          !detail && !onClose && "hidden",
        )}
      >
        <PullRequestDetailCrumbs
          detail={detail}
          toneClassName={statePresentation?.toneClassName ?? null}
          condensed={condensed}
          repositoryUrl={repositoryUrl}
          openOnHostText={openOnHostText}
          onBack={onBack}
        />
        <div className="mr-4 flex h-7 shrink-0 select-none items-center justify-end gap-1">
          {detail ? (
            <TooltipProvider delay={150} closeDelay={150} timeout={400}>
              {context === "page" ? (
                <PullRequestThreadLinks
                  display="count"
                  environmentId={environmentId}
                  reference={reference}
                  url={detail.url}
                  threadRef={null}
                />
              ) : null}
              {!nativeStack && supportsStackActions && nativeStackQuery.error ? (
                <Button variant="ghost" size="xs" onClick={nativeStackQuery.refresh}>
                  Retry stack lookup
                </Button>
              ) : null}
              {nativeStack ? (
                <PullRequestStackMenu
                  hostLabel={hostClient.label}
                  terminology={terminology}
                  stack={nativeStack}
                  notice={nativeStackQuery.notice}
                  onRetry={nativeStackQuery.error ? nativeStackQuery.refresh : undefined}
                  reference={reference}
                  environmentId={environmentId}
                  onSelect={onSelectPullRequest}
                  mergeMethod={selectedMergeMethod}
                  stale={!nativeStackQuery.isFresh}
                  canMerge={supportsStackActions && can("merge") && allowedMergeMethods.length > 0}
                  canRebase={supportsStackActions && detail.viewerPermissions.stackRebase === true}
                  onActed={() => {
                    refreshDetail();
                    onActed?.();
                  }}
                />
              ) : null}
              <PullRequestPrimaryAction
                mergeBlockedReason={mergeBlockedReason}
                pullRequestKey={pullRequestKey}
                primaryAction={primaryAction}
                autoMergeArmed={autoMergeArmed}
                armedAutoMergeLabel={armedAutoMergeLabel}
                pendingAutoMergeLabel={pendingAutoMergeLabel}
                selectedMergeMethod={selectedMergeMethod}
                selectedMergeMethodLabel={selectedMergeMethodLabel}
                statePresentation={statePresentation}
                pendingAction={pendingAction}
                perform={perform}
                resolveConflicts={resolveConflictsControl}
              />
              {checkoutControl}
              <PullRequestActionsMenu
                environmentId={environmentId}
                reference={reference}
                pullRequestKey={pullRequestKey}
                detail={detail}
                terminology={terminology}
                linkThreadRef={
                  threadRef ??
                  (typeof composerDraftTarget === "object" ? composerDraftTarget : null)
                }
                onThreadPickerOpenChange={setThreadPickerOpen}
                refreshing={refreshing}
                refreshFromHost={refreshFromHost}
                handoff={handoff}
                attachesToComposer={attachTarget !== null}
                askAboutPullRequest={askAboutPullRequest}
                explainPullRequest={explainPullRequest}
                canFixFindings={canFixFindings}
                startFixFindings={startFixFindings}
                handoffLabels={handoffLabels}
                canWriteGuide={reviewGuidesEnabled && guideWriter.canWrite}
                guideRunning={guideWriter.running}
                guideWritten={guideWriter.data?.guide != null}
                writeGuide={writeGuide}
                pickableEnvironments={pickableEnvironments}
                actingEnvironmentId={actingEnvironmentId}
                onActingEnvironmentChange={selectActingEnvironment}
                can={can}
                autoMergeArmed={autoMergeArmed}
                showsDraftToggle={showsDraftToggle}
                showsMergeNow={showsMergeNow}
                showsAutoMerge={showsAutoMerge}
                showsMergeMethods={showsMergeMethods}
                allowedMergeMethods={allowedMergeMethods}
                selectedMergeMethod={selectedMergeMethod}
                onSelectMergeMethod={selectMergeMethod}
                showsDeleteBranch={showsDeleteBranch}
                environmentConnected={environmentConnected}
                canWriteSourceControl={canWriteSourceControl}
                onMaintainerEditsSaved={refreshDetail}
                confirmDeleteBranch={confirmDeleteBranch}
                pendingAction={pendingAction}
                perform={perform}
                openOnHostText={openOnHostText}
                copyReference={copyReference}
              />
            </TooltipProvider>
          ) : null}
          {onClose ? (
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={`Collapse ${terminology.singular} panel`}
              onClick={onClose}
            >
              <PanelRightIcon className="size-3.5" />
            </Button>
          ) : null}
        </div>

        <div
          className={cn(
            "col-span-2 grid",
            condensed
              ? "grid-rows-[1fr]"
              : "grid-rows-[0fr] transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none",
          )}
        >
          <div
            ref={condensedRowRef}
            className={cn(
              "min-h-0 overflow-hidden transition-[opacity,transform] duration-150 ease-out motion-reduce:transform-none motion-reduce:transition-none",
              condensed
                ? "translate-y-0 opacity-100 delay-50"
                : "translate-y-1 opacity-0 duration-100",
            )}
            inert={!condensed}
          >
            {detail ? (
              <div className="col-span-2 min-w-0 px-4 pb-2 pt-1">
                <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                  <span className="flex min-w-0 shrink items-center gap-1.5 overflow-hidden text-xs text-muted-foreground">
                    <PullRequestActorLabel
                      actor={detail.author}
                      profileUrl={authorProfileUrl}
                      variant="avatar"
                      className="shrink-0"
                    />
                    <span className="shrink-0">
                      <RelativeTime timestamp={detail.updatedAt} />
                    </span>
                  </span>
                  <span aria-hidden className="h-3 w-px shrink-0 bg-border/70" />
                  <span className="flex min-w-0 flex-1 items-center gap-1.5 font-mono text-2xs text-muted-foreground/65">
                    <PullRequestBaseBranch
                      baseBranch={detail.baseBranch}
                      freshness={freshness}
                      stacked={isStackedPullRequest}
                      pending={actionPending}
                      onUpdate={(method) => void perform("update-branch", undefined, method)}
                      iconClassName="size-3"
                    />
                    <ArrowLeftIcon
                      aria-label="receives changes from"
                      className="size-3 shrink-0 opacity-60"
                    />
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <code className="flex min-w-0 flex-1">
                            <MiddleTruncate value={detail.headBranch} showTitle={false} />
                          </code>
                        }
                      />
                      <TooltipPopup side="top">{detail.headBranch}</TooltipPopup>
                    </Tooltip>
                  </span>
                  <span className="ml-auto inline-flex shrink-0 items-baseline justify-end gap-2 text-2xs">
                    <span
                      className="inline-flex items-baseline gap-1 tabular-nums"
                      aria-label={`${detail.changedFiles.toLocaleString()} changed ${
                        detail.changedFiles === 1 ? "file" : "files"
                      }`}
                    >
                      <FileDiffIcon aria-hidden className="size-3 self-center" />
                      {detail.changedFiles.toLocaleString()}
                    </span>
                    <PullRequestChangeBreakdownStat
                      environmentId={environmentId}
                      reference={reference}
                      additions={detail.additions}
                      deletions={detail.deletions}
                      className="shrink-0 font-mono text-2xs"
                      eager
                    />
                  </span>
                </div>
              </div>
            ) : null}
          </div>
        </div>

        <div
          className={cn(
            "col-span-2 grid",
            condensed
              ? "grid-rows-[0fr]"
              : "grid-rows-[1fr] transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none",
          )}
        >
          <div
            ref={foldRef}
            className={cn(
              "min-h-0 overflow-hidden transition-[opacity,transform] duration-150 ease-out motion-reduce:transform-none motion-reduce:transition-none",
              condensed
                ? "-translate-y-1 opacity-0 duration-100"
                : "translate-y-0 opacity-100 delay-50",
            )}
            inert={condensed}
          >
            {detail ? (
              <PullRequestDetailHeaderBody
                title={
                  <PullRequestTitleEditor
                    environmentId={environmentId}
                    reference={reference}
                    pullRequestKey={pullRequestKey}
                    detail={detail}
                    canWriteSourceControl={canWriteSourceControl}
                    onSaved={refreshDetail}
                  />
                }
                author={
                  <PullRequestActorLabel actor={detail.author} profileUrl={authorProfileUrl} />
                }
                updated={
                  <span>
                    updated <RelativeTime timestamp={detail.updatedAt} />
                  </span>
                }
                checkout={
                  checkoutCommand ? (
                    <PullRequestCopyableCode
                      key={checkoutCommand}
                      value={checkoutCommand}
                      target={`${terminology.singular} checkout command`}
                      copyLabel="Copy checkout command"
                      copiedLabel="Checkout command copied"
                      className="ml-auto font-mono"
                      tooltipSide="bottom"
                      onError={reportCheckoutCommandError}
                    />
                  ) : null
                }
                base={
                  <PullRequestBaseBranch
                    baseBranch={detail.baseBranch}
                    freshness={freshness}
                    stacked={isStackedPullRequest}
                    pending={actionPending}
                    onUpdate={(method) => void perform("update-branch", undefined, method)}
                  />
                }
                head={
                  <PullRequestCopyableCode
                    key={detail.headBranch}
                    value={detail.headBranch}
                    target="branch name"
                    copyLabel={`Copy ${terminology.singular} branch`}
                    copiedLabel="Branch name copied"
                  />
                }
                files={`${detail.changedFiles.toLocaleString()} ${detail.changedFiles === 1 ? "file" : "files"}`}
                diffStat={
                  <PullRequestChangeBreakdownStat
                    environmentId={environmentId}
                    reference={reference}
                    additions={detail.additions}
                    deletions={detail.deletions}
                    className="shrink-0 font-mono text-xs"
                    eager
                  />
                }
              />
            ) : null}
          </div>
        </div>

        {detail ? (
          <PullRequestDetailTabBar
            tabs={visibleTabs}
            value={tab}
            onValueChange={selectTab}
            onTabIntent={(item) => {
              if (item === "code") void loadCodeTab();
            }}
          >
            {tab === "summary" ? (
              showsApproveWorkflows ? (
                <PullRequestApproveWorkflowsButton
                  pullRequestKey={pullRequestKey}
                  pendingAction={pendingAction}
                  perform={perform}
                />
              ) : (
                <PullRequestChecksStatusLine
                  className="text-muted-foreground"
                  aria-label={checksSummary ? `Checks: ${checksSummary}` : "Checks"}
                  icon={
                    checksState !== null ? (
                      <PullRequestChecksPopover
                        checks={detail.checks}
                        stale={checksStale}
                        checksState={checksState}
                        threadRef={threadRef}
                      />
                    ) : (
                      <CircleDotIcon aria-hidden className="size-3.5" />
                    )
                  }
                  label={checksSummary}
                />
              )
            ) : tab === "timeline" ? (
              <div className="ml-auto flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                <PullRequestMetaLine
                  className={cn(
                    "whitespace-nowrap text-2xs transition-opacity",
                    (activityPending || activityError) && "opacity-35",
                  )}
                >
                  <span
                    className="inline-flex items-center gap-1"
                    aria-label={
                      activityError
                        ? "Comments unavailable"
                        : `${detail.commentCount.toLocaleString()} ${
                            detail.commentCount === 1 ? "comment" : "comments"
                          }`
                    }
                  >
                    <MessageSquareIcon aria-hidden className="size-3" />
                    {activityError
                      ? "-"
                      : activityPending
                        ? "…"
                        : detail.commentCount.toLocaleString()}
                  </span>
                  <span
                    className="inline-flex items-center gap-1"
                    aria-label={
                      activityError
                        ? "Commits unavailable"
                        : `${detail.commits.length.toLocaleString()} ${
                            detail.commits.length === 1 ? "commit" : "commits"
                          }`
                    }
                  >
                    <GitCommitHorizontalIcon aria-hidden className="size-3" />
                    {activityError
                      ? "-"
                      : activityPending
                        ? "…"
                        : detail.commits.length.toLocaleString()}
                  </span>
                  {approvalCount > 0 ? (
                    <span
                      className={cn(
                        "inline-flex items-center gap-1",
                        pullRequestReviewOutcomeToneClassName("approved"),
                      )}
                    >
                      <PullRequestReviewOutcomeIcon outcome="approved" className="size-3" />
                      {approvalCount.toLocaleString()}
                      <span className="sr-only">
                        {approvalCount === 1 ? "approval" : "approvals"}
                      </span>
                    </span>
                  ) : null}
                </PullRequestMetaLine>
                <Button
                  size="xs"
                  variant="ghost-muted"
                  aria-label={
                    timelineOrder === "newest"
                      ? "Show oldest activity first"
                      : "Show newest activity first"
                  }
                  onClick={() =>
                    setTimelineOrder((value) => (value === "newest" ? "oldest" : "newest"))
                  }
                >
                  <ArrowDownUpIcon aria-hidden className="size-3" />
                  {timelineOrder === "newest" ? "Newest first" : "Oldest first"}
                </Button>
              </div>
            ) : null}
          </PullRequestDetailTabBar>
        ) : null}
      </div>

      <SourceControlAppAccessNotice
        environmentId={environmentId}
        provider={detail?.provider ?? repositoryIdentity?.provider}
        host={reference.host}
        repository={reference.repository}
        className="border-b border-border/60"
      />
      <div
        className="relative flex min-h-0 flex-1 flex-col overflow-hidden"
        onScrollCapture={(event) => {
          const scroller = scrollerByTab.current[tab];
          if (event.target !== scroller || scroller === null || scroller === undefined) return;
          const top = scroller.scrollTop;
          const previous = condensedByTab[tab] ?? false;
          const foldHeight = foldRef.current?.scrollHeight ?? 0;
          let next = previous;
          if (previous) {
            if (top < 4 && foldHeight > 0) next = false;
          } else if (foldHeight > 0 && top > foldHeight + 32) {
            const chromeDelta = foldHeight - (condensedRowRef.current?.scrollHeight ?? 0);
            compensationRef.current = { tab, scroller, target: top - chromeDelta };
            next = true;
          }
          if (next !== previous) setCondensedByTab({ ...condensedByTab, [tab]: next });
        }}
      >
        {detailQuery.error && !detail ? (
          <PullRequestsUnavailableState
            {...(isPullRequestNotFound(detailQuery.failure)
              ? {
                  title: `${capitalizeTerm(terminology.singular)} #${reference.number} not found`,
                  error: `It may be an issue rather than a ${terminology.singular}, or this account can't see it.`,
                }
              : { error: detailQuery.error })}
            refreshing={detailQuery.isPending}
            onRetry={refreshDetail}
            {...(unavailableHostUrl
              ? {
                  host: {
                    url: unavailableHostUrl,
                    openLabel: openOnHostLabel(
                      sourceControlClients.get(repositoryIdentity?.provider),
                    ),
                  },
                }
              : {})}
          />
        ) : detail ? (
          <PullRequestMarkdownContext value={markdownContext}>
            {mountedTabs.has("summary") ? (
              <div className={cn("absolute inset-0", tab !== "summary" && "invisible")}>
                <PullRequestSummaryTab
                  scrollerRef={scrollerRefs.summary}
                  environmentId={environmentId}
                  threadRef={threadRef}
                  reference={reference}
                  detail={detail}
                  activityPending={activityPending}
                  checksStale={checksStale}
                  activityError={activityError}
                  pendingFinding={handoff}
                  fixFindingLabel={handoffLabels.fixFinding}
                  fixCheckLabel={handoffLabels.fixCheck}
                  {...(canFixFindings ? { onFixFinding: startFixFinding } : {})}
                  onRefresh={refreshDetail}
                  onRefreshChecks={refreshFromHost}
                />
              </div>
            ) : null}
            {mountedTabs.has("guide") ? (
              <div
                className={cn("absolute inset-0", tab !== "guide" && "invisible")}
                // Read by the guide run notifier, which stays quiet for a guide on screen.
                data-guide-shown={tab === "guide" ? guideKey : undefined}
              >
                <PullRequestGuideTab
                  environmentId={environmentId}
                  reference={reference}
                  active={tab === "guide"}
                  title={detail.title}
                  workspaceRoot={detail.workspaceRoot}
                  canComment={
                    detail.capabilities.review.inlineComment && detail.viewerPermissions.comment
                  }
                  rangeComments={detail.capabilities.review.rangeComment === true}
                  onAskAboutLines={(comment, request) =>
                    addSelectionToAgent({ comment, request }, { keepGuide: true })
                  }
                  onAskAboutStop={askAboutGuideStop}
                  onFinishReview={
                    detail.capabilities.review.verdicts.some((verdict) =>
                      detail.viewerPermissions.verdicts.includes(verdict),
                    )
                      ? () => setOpenReviewRequest((count) => count + 1)
                      : null
                  }
                  onOpenFile={openFileInCode}
                  onTourShown={onGuideShown}
                />
              </div>
            ) : null}
            {mountedTabs.has("timeline") ? (
              <div className={cn("absolute inset-0", tab !== "timeline" && "invisible")}>
                {activityPending ? (
                  <PullRequestTimelineGhost />
                ) : activityError ? (
                  <PullRequestActivityUnavailableState
                    error={activityError}
                    term={terminology.singular}
                    onRetry={activityQuery.refresh}
                  />
                ) : (
                  <PullRequestTimelineTab
                    scrollerRef={scrollerRefs.timeline}
                    detail={detail}
                    environmentId={environmentId}
                    threadRef={threadRef}
                    reference={reference}
                    order={timelineOrder}
                    onOpenCommit={openCommit}
                    onRefresh={refreshDetail}
                  />
                )}
              </div>
            ) : null}
            {mountedTabs.has("code") ? (
              <div className={cn("absolute inset-0", tab !== "code" && "invisible")}>
                <Suspense
                  fallback={
                    <DiffPanelLoadingState label={`Loading ${terminology.singular} diff...`} />
                  }
                >
                  <PullRequestCodeTab
                    scrollerRef={scrollerRefs.code}
                    onAddToAgentSelection={addSelectionToAgent}
                    environmentId={environmentId}
                    reference={reference}
                    detail={detail}
                    selectedCommitOid={selectedCodeCommitOid}
                    onSelectedCommitChange={selectCodeCommit}
                    pendingFinding={handoff}
                    fixFindingLabel={handoffLabels.fixFinding}
                    {...(canFixFindings ? { onFixFinding: startFixFinding } : {})}
                    onRefresh={refreshDetail}
                    refreshToken={refreshToken}
                    backgroundRefreshToken={turnRefresh ?? 0}
                    revealRequest={codeRevealRequest}
                  />
                </Suspense>
              </div>
            ) : null}
          </PullRequestMarkdownContext>
        ) : null}
      </div>

      {detail ? (
        <div className="absolute right-4 bottom-3 z-20">
          <PullRequestComposer
            key={JSON.stringify([
              environmentId,
              reference.projectId,
              reference.host,
              reference.repository,
              reference.number,
            ])}
            environmentId={environmentId}
            reference={reference}
            detail={detail}
            actionPending={actionPending}
            onCommentAction={performCommentAction}
            onCommented={refreshDetail}
            onReviewSubmitted={refreshDetail}
            openReviewRequest={openReviewRequest}
          />
        </div>
      ) : null}
    </div>
  );
}
