import type { LegendListRef } from "@legendapp/list/react";
import {
  deriveRunlessWorkStartedAt,
  deriveThreadActivityRun,
  deriveThreadStructureRuntime,
} from "@t3tools/client-runtime/state/thread-execution";
import { createQuestionHistoryProjector } from "@t3tools/client-runtime/state/thread-requests";
import {
  EnvironmentId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { useRef, useState, type ReactNode } from "react";

import { useIncrementalTimelineEntries } from "~/hooks/useIncrementalTimelineEntries";
import { SideThreadsOpenContext } from "~/hooks/useSideThreadTrigger";
import { useTheme } from "~/hooks/useTheme";
import { deriveActiveWorkStartedAt, derivePhase } from "~/session-logic";
import type { ChatFileAttachment } from "~/types";

import type { ExpandedImagePreview } from "./ExpandedImagePreview";
import { MessagesTimeline, type MessagesTimelineHistoryControls } from "./MessagesTimeline";
import { ScrollToEndButton } from "./TimelineOverlays";
import type { TimelineRow, TurnItemSource } from "./timelineRowContext";
import { useTimelineFollow } from "./useTimelineFollow";

// The timeline needs an environment id to key its rows. No environment answers to this one, so a
// row that would ask the thread's environment for something gets nothing.
const NO_ENVIRONMENT_ID = EnvironmentId.make("guest");
const NO_TURN_DIFFS: ReadonlyArray<never> = [];
const NO_OPTIMISTIC_MESSAGES: ReadonlyArray<never> = [];
const ignore = () => {};

/**
 * A thread's own timeline, built from its projection alone and read-only: every action that would
 * reach the thread's environment (fork, revert, reply, diffs, files, other threads, shell,
 * approvals) is left out, so its control does not render. The guest page and a linked
 * environment's thread both show a thread this way.
 */
export function ReadOnlyThreadTimeline(props: {
  /** Keys the list. It holds no ":" so the timeline finds no environment thread behind it. */
  readonly threadKey: string;
  readonly projection: OrchestrationV2ThreadProjection;
  readonly historyControls: MessagesTimelineHistoryControls | undefined;
  /** Where expanded rows read an item's detail. */
  readonly turnItemSource: TurnItemSource;
  /** Preview URLs for the messages' attachments, keyed by attachment id. */
  readonly attachmentUrls: (
    items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
  ) => ReadonlyMap<string, string>;
  readonly onImageExpand: (preview: ExpandedImagePreview) => void;
  readonly onFileOpen: (file: ChatFileAttachment) => void;
  readonly renderHtmlRender: (row: Extract<TimelineRow, { kind: "html-render" }>) => ReactNode;
  readonly renderMcpApp: (row: Extract<TimelineRow, { kind: "mcp-app" }>) => ReactNode;
  readonly renderFooter?: (items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>) => ReactNode;
  /** What stands below the timeline, where the composer would. */
  readonly children: (controls: { readonly scrollToEnd: () => void }) => ReactNode;
}) {
  const { threadKey, projection } = props;
  const listRef = useRef<LegendListRef | null>(null);
  const { resolvedTheme } = useTheme();
  // The rest is what ChatView derives from the same projection.
  const [projectQuestionHistory] = useState(() => createQuestionHistoryProjector());
  const items = projectQuestionHistory(projection);
  const entries = useIncrementalTimelineEntries(threadKey, {
    visibleTurnItems: items,
    optimisticMessages: NO_OPTIMISTIC_MESSAGES,
    attachmentUrlById: props.attachmentUrls(items),
    attempts: projection.attempts,
    nodes: projection.nodes,
    plans: projection.plans,
  });
  const activityRun = deriveThreadActivityRun(projection);
  const runtime = deriveThreadStructureRuntime(projection);
  const runlessWorkStartedAt = deriveRunlessWorkStartedAt(projection);
  const isWorking = derivePhase(runtime) === "running" || runlessWorkStartedAt !== null;
  const workStartedAt =
    deriveActiveWorkStartedAt(activityRun, runtime, null) ?? runlessWorkStartedAt;
  const runningRunId = runtime?.activeRunId ?? null;
  const follow = useTimelineFollow({
    legendListRef: listRef,
    composerTimelineInset: 0,
    routeThreadKey: threadKey,
    activeThreadKey: threadKey,
    // Not a server thread: new turns follow the end instead of anchoring near the top.
    isServerThread: false,
    serverProjection: null,
    threadStatus: "live",
    activeActivityRun: activityRun,
    activeRunningTurnId: runningRunId,
    timelineEntries: entries,
    timelineAnchorMessageId: null,
    setTimelineAnchor: ignore,
  });
  return (
    <>
      <div className="relative min-h-0 flex-1">
        <SideThreadsOpenContext value={false}>
          <MessagesTimeline
            listRef={listRef}
            timelineEntries={entries}
            isWorking={isWorking}
            activeTurnStartedAt={workStartedAt}
            latestRun={activityRun}
            runningRunId={runningRunId}
            turnDiffSummaries={NO_TURN_DIFFS}
            runs={projection.runs}
            routeThreadKey={threadKey}
            onOpenThread={ignore}
            supportsConversationRollback={false}
            onRevertToTurnCount={ignore}
            isRevertingCheckpoint={false}
            onImageExpand={props.onImageExpand}
            onFileOpen={props.onFileOpen}
            onFileDownload={props.onFileOpen}
            renderHtmlRender={props.renderHtmlRender}
            renderMcpApp={props.renderMcpApp}
            turnItemSource={props.turnItemSource}
            historyControls={props.historyControls}
            activeThreadEnvironmentId={NO_ENVIRONMENT_ID}
            markdownCwd={undefined}
            resolvedTheme={resolvedTheme}
            timestampFormat="locale"
            workspaceRoot={undefined}
            anchorMessageId={null}
            onAnchorReady={ignore}
            onAnchorSizeChanged={ignore}
            contentInsetEndAdjustment={0}
            emptyPlaceholderInset={0}
            liveFollowEnabled={follow.timelineLiveFollowEnabled}
            onIsAtEndChange={follow.onIsAtEndChangeStable}
            onViewportAttach={follow.attachTimelineViewport}
            onFooterGrow={follow.onTimelineFooterGrowStable}
            footer={props.renderFooter?.(items) ?? null}
          />
        </SideThreadsOpenContext>
        {follow.showScrollToBottom ? (
          <ScrollToEndButton
            summary={null}
            bottom={4}
            onScrollToEnd={() => follow.scrollToEnd(true)}
          />
        ) : null}
      </div>
      {props.children({ scrollToEnd: () => follow.scrollToEnd(true) })}
    </>
  );
}
