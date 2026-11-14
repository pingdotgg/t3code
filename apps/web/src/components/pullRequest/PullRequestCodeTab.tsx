import { capitalizeTerm, sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import type { PullRequestReviewThread } from "@t3tools/contracts";
import { ChevronRightIcon } from "lucide-react";
import { useEffect, useEffectEvent, type ReactNode } from "react";

import { resolveFileDiffPath } from "~/lib/diffRendering";
import { cn } from "~/lib/utils";

import { DiffPanelLoadingState } from "../DiffPanelShell";
import { DiffFileTree } from "../diffs/DiffFileTree";
import { FileExplorerPane } from "../files/FileExplorerPane";
import { StyledDiffCodeView } from "../diffs/StyledDiffCodeView";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toggleFileDiffFoldForViewed } from "./pullRequestDiff.logic";
import { PullRequestDiffUnavailableState } from "./PullRequestDiffUnavailableState";
import {
  FileViewedToggleContext,
  REPLACE_FILE_COUNTS_CSS,
  ReviewAnnotationGroup,
  type PullRequestCodeTabProps,
} from "./pullRequestCodeTabShared";
import {
  usePullRequestCodeTabState,
} from "./usePullRequestCodeTabState";
import { usePullRequestCodeTabRender } from "./usePullRequestCodeTabRender";

function PullRequestCodeTab(props: PullRequestCodeTabProps) {
  const {
  scrollerRef,
  environmentId,
  reference,
  detail,
  selectedCommitOid,
  onSelectedCommitChange,
  pendingFinding,
  fixFindingLabel = "Fix in a thread",
  onFixFinding,
  onAddToAgentSelection,
  onRefresh,
  refreshToken = 0,
  backgroundRefreshToken = 0,
  revealRequest = null,
  } = props;
  const state = usePullRequestCodeTabState(props);
  const rendered = usePullRequestCodeTabRender({ ...state, props });
  const {
    isRevealAnswered,
    markRevealAnswered,
    canLoadNextSlice,
    codeViewReveal,
    commit,
    cursor,
    data,
    diffQuery,
    diffViewOptions,
    effectiveFoldOverride,
    fileTreeEntries,
    fileTreeOpen,
    fileViewedToggle,
    files,
    items,
    loadNextSlice,
    loadedSlices,
    nextCursor,
    orphansOpen,
    placedThreadIds,
    rawSlicesView,
    renderCodeViewFooter,
    renderHeaderMetadata,
    renderHeaderPrefix,
    revealFile,
    selectedLines,
    setOrphansOpen,
    setSelectedLines,
    setToggledFiles,
    toggleFile,
    unstructured,
  } = state;
  const {
    renderAnnotation,
    renderThreadCard,
    toolbar,
  } = rendered;

  const answerReveal = useEffectEvent(() => {
    if (revealRequest === null || isRevealAnswered(revealRequest.nonce)) return;
    if (!items.some((item) => resolveFileDiffPath(item.fileDiff) === revealRequest.path)) {
      if (canLoadNextSlice) loadNextSlice();
      return;
    }
    markRevealAnswered(revealRequest.nonce);
    revealFile(revealRequest.path);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolls the code view to a requested file once loaded, or pages forward until it arrives
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- A reveal for a file not loaded yet pages forward, which sets the slice cursor.
    answerReveal();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Re-checked as pages load until the requested file arrives.
  }, [canLoadNextSlice, items, revealRequest]);
  const withToolbar = (body: ReactNode) => (
    <div className="flex h-full min-h-0 flex-col">
      {toolbar}
      <div ref={scrollerRef} className="min-h-0 flex-1 overflow-auto">
        {body}
      </div>
    </div>
  );

  const term = sourceControlClients.get(detail.provider).changeRequest.singular;
  if (diffQuery.isPending && loadedSlices.length === 0) {
    return withToolbar(<DiffPanelLoadingState label={`Loading ${term} diff...`} />);
  }

  if (diffQuery.error && loadedSlices.length === 0) {
    return withToolbar(
      <PullRequestDiffUnavailableState
        error={diffQuery.error}
        provider={detail.provider}
        url={detail.url}
        onRetry={() => diffQuery.refresh()}
      />,
    );
  }

  if (rawSlicesView !== null) {
    return withToolbar(rawSlicesView);
  }

  if (items.length === 0 && nextCursor === null) {
    return withToolbar(
      <p className="px-4 py-5 text-sm text-muted-foreground">
        {commit === null ? `This ${term} has no file changes.` : "This commit has no file changes."}
      </p>,
    );
  }

  const orphanThreads = detail.reviewThreads.filter((thread) => !placedThreadIds.has(thread.id));
  const orphanFiles = new Map<string, PullRequestReviewThread[]>();
  for (const thread of orphanThreads) {
    const existing = orphanFiles.get(thread.path);
    if (existing) existing.push(thread);
    else orphanFiles.set(thread.path, [thread]);
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {toolbar}
      {orphanFiles.size > 0 ? (
        <div className="shrink-0 border-b border-border/60">
          <Collapsible open={orphansOpen} onOpenChange={setOrphansOpen}>
            <h2>
              <CollapsibleTrigger className="flex w-full items-center gap-1.5 px-4 py-2 text-left text-xs text-muted-foreground">
                <span>
                  {nextCursor === null
                    ? "Conversations not on the current diff"
                    : "Conversations not on the diff loaded so far"}
                </span>
                <ChevronRightIcon
                  aria-hidden
                  className={cn("size-3.5 transition-transform", orphansOpen && "rotate-90")}
                />
                <span aria-hidden className="tabular-nums">
                  {orphanThreads.length}
                </span>
                <span className="sr-only">
                  {orphanThreads.length === 1
                    ? "1 conversation"
                    : `${orphanThreads.length} conversations`}
                </span>
              </CollapsibleTrigger>
            </h2>
            <CollapsiblePanel>
              <div className="max-h-64 space-y-3 overflow-auto px-4 pb-3">
                {[...orphanFiles].map(([path, threads]) => (
                  <div key={path}>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <p className="truncate px-3 text-xs text-muted-foreground">{path}</p>
                        }
                      />
                      <TooltipPopup side="top">{path}</TooltipPopup>
                    </Tooltip>
                    <div className="mt-1 space-y-2">
                      {threads.map((thread) => (
                        <div key={thread.id}>
                          {thread.line === null ? null : (
                            <p className="px-3 text-xs text-muted-foreground">Line {thread.line}</p>
                          )}
                          {renderThreadCard(thread)}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </CollapsiblePanel>
          </Collapsible>
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div
          className="relative min-h-0 min-w-0 flex-1"
          // Headers live in shadow DOM; composedPath crosses that boundary.
          onClickCapture={(event) => {
            const composedPath = event.nativeEvent.composedPath?.() ?? [];
            for (const node of composedPath) {
              if (!(node instanceof HTMLElement)) continue;
              if (node instanceof HTMLButtonElement || node instanceof HTMLAnchorElement) {
                return;
              }
              if (node.hasAttribute("data-viewed-toggle")) return;
              if (node.hasAttribute("data-diffs-header")) {
                const filePath = node.querySelector("[data-title]")?.textContent?.trim();
                if (filePath === undefined || filePath === "") return;
                const item = items.find(
                  (candidate) => resolveFileDiffPath(candidate.fileDiff) === filePath,
                );
                if (item !== undefined) toggleFile(item.id);
                return;
              }
            }
          }}
        >
          {/* The viewer must own its scroll element to position virtual rows within it. */}
          <FileViewedToggleContext value={fileViewedToggle}>
            <StyledDiffCodeView<ReviewAnnotationGroup>
              className="@container h-full overflow-auto [scrollbar-gutter:stable]"
              containerRef={scrollerRef}
              viewerRef={codeViewReveal.attach}
              items={items}
              selectedLines={selectedLines}
              onSelectedLinesChange={setSelectedLines}
              options={diffViewOptions}
              renderCodeViewFooter={renderCodeViewFooter}
              renderHeaderPrefix={renderHeaderPrefix}
              renderHeaderMetadata={renderHeaderMetadata}
              renderAnnotation={renderAnnotation}
              // Find may repeat requests before render; only unfold, never toggle.
              onRevealSearchMatch={(item) =>
                setToggledFiles((current) =>
                  toggleFileDiffFoldForViewed(item.id, false, effectiveFoldOverride, current),
                )
              }
              unsafeCSSExtra={REPLACE_FILE_COUNTS_CSS}
            />
          </FileViewedToggleContext>
        </div>
        {fileTreeOpen ? (
          <FileExplorerPane
            resizable
            storageKey="t3code:diff-file-tree-width"
            defaultWidth={320}
            defaultWidthFraction={0.4}
            minWidth={192}
            resizeLabel="Resize PR Code files"
          >
            <DiffFileTree
              ariaLabel={`${capitalizeTerm(term)} #${detail.number} files`}
              entries={fileTreeEntries}
              onSelectFile={revealFile}
              footer={
                nextCursor === null ? null : (
                  <div className="shrink-0 border-t border-border/60 p-2">
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      className="w-full"
                      disabled={diffQuery.isPending}
                      onClick={diffQuery.error !== null ? () => diffQuery.refresh() : loadNextSlice}
                    >
                      {diffQuery.error !== null
                        ? "Retry"
                        : diffQuery.isPending
                          ? "Loading more files..."
                          : "Load more files"}
                    </Button>
                  </div>
                )
              }
            />
          </FileExplorerPane>
        ) : null}
      </div>
      {unstructured}
    </div>
  );
}

export type { PullRequestAgentSelectionInput } from "./pullRequestCodeTabShared";
export default PullRequestCodeTab;
