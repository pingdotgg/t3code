import { useAtomValue } from "@effect/atom-react";
import type { LegendListRef } from "@legendapp/list/react";
import type { ReactNode } from "react";
import { useLayoutEffect, useRef } from "react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ThreadStructure } from "@t3tools/client-runtime/state/shell";
import {
  deriveRunlessWorkStartedAt,
  deriveThreadActivityRun,
  deriveThreadStructureRuntime,
} from "@t3tools/client-runtime/state/thread-execution";
import type {
  AssistantCitation,
  ProviderApprovalDecision,
  RuntimeRequestId,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { useClientSettings } from "~/hooks/useSettings";
import { useTheme } from "~/hooks/useTheme";
import { environmentThreadDetails } from "~/state/threads";
import { answeredCardAnswers } from "@t3tools/shared/quizCard";
import type { AssistantCitationSourceAnchor } from "~/lib/assistantTextSelection";
import { deriveActiveWorkStartedAt, derivePhase, type PendingApproval } from "../../session-logic";
import type { ChatMessage } from "../../types";
import type { AssistantCitationRequest } from "../chat/AssistantCitationSource";
import { WorkspaceMutationIdContext } from "../chat/ChatMarkdownMedia";
import { useCitedHistory } from "../chat/citationProcedure";
import { openExpandedImagePreview } from "../chat/ExpandedImageDialog";
import { ThreadTimeline } from "../chat/ThreadTimeline";
import { ScrollToEndButton } from "../chat/TimelineOverlays";
import { useStableCallback } from "../../hooks/useStableCallback";
import { useTimelineFollow } from "../chat/useTimelineFollow";
import { readTimelinePosition } from "../chat/timelineScrollAnchoring";
import type { TimelineViewport } from "../chat/timelineViewport";

const noop = () => {};
const EMPTY_TIMELINE_ENTRIES = [] as const;
const NO_WORKSPACE_MUTATION_ID_ATOM = Atom.make<string | null | undefined>(undefined);

/**
 * A side chat's timeline in the lesson's panel. It stays out of the held-timeline
 * cache and offers none of the lesson's thread actions (fork, rollback, revert,
 * turn diffs, worktree setup, artifact templates).
 */
export function SideChatTimeline(props: {
  readonly lessonRef: ScopedThreadRef;
  readonly sideChatRef: ScopedThreadRef;
  /** Null until the side chat's detail may load. */
  readonly detailRef: ScopedThreadRef | null;
  readonly projection: ThreadStructure | null;
  /** The highlight the side chat is about; null until known. */
  readonly label: string | null;
  readonly detailLoading: boolean;
  readonly optimisticMessages: ReadonlyArray<ChatMessage>;
  readonly attachmentUrlById?: ReadonlyMap<string, string>;
  readonly listRef: React.RefObject<LegendListRef | null>;
  readonly citationRequest: AssistantCitationRequest | null;
  readonly askInSideChatPending: boolean;
  readonly onCiteAssistantText: (
    citation: AssistantCitation,
    sourceAnchor: AssistantCitationSourceAnchor,
  ) => boolean;
  /** Undefined when the connection cannot operate the thread. */
  readonly onAskInSideChat:
    | ((
        citation: AssistantCitation,
        sourceAnchor?: AssistantCitationSourceAnchor,
        embedTitle?: string,
      ) => boolean)
    | undefined;
  readonly onOpenThread: (threadId: ThreadId) => void;
  /** Opens a side chat nested in this one from its mark. */
  readonly onOpenSideChat?: (threadId: ThreadId) => void;
  readonly workspaceRoot: string | undefined;
  /** Shown on their timeline rows, as the lesson's are. */
  readonly pendingApprovals: ReadonlyArray<PendingApproval>;
  readonly respondingRequestIds: ReadonlyArray<RuntimeRequestId>;
  readonly canOperate: boolean;
  readonly onRespondToApproval: (
    requestId: RuntimeRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<unknown>;
  readonly footer?: ReactNode;
  readonly onSendAppMessage?: (text: string) => Promise<void>;
}) {
  const { projection, workspaceRoot } = props;
  const sideChatKey = scopedThreadKey(props.sideChatRef);
  const lessonKey = scopedThreadKey(props.lessonRef);
  const { resolvedTheme } = useTheme();
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const citationHistory = useCitedHistory(props.citationRequest);

  // Run state as ChatView derives it for a server thread.
  const activityRun = projection === null ? null : deriveThreadActivityRun(projection);
  const runtime = projection === null ? null : deriveThreadStructureRuntime(projection);
  const runlessWorkStartedAt = projection === null ? null : deriveRunlessWorkStartedAt(projection);
  const isWorking = derivePhase(runtime) === "running" || runlessWorkStartedAt !== null;
  const follow = useTimelineFollow({
    legendListRef: props.listRef,
    composerTimelineInset: 0,
    routeThreadKey: sideChatKey,
    activeThreadKey: sideChatKey,
    isServerThread: false,
    serverProjection: null,
    threadStatus: "live",
    activeActivityRun: activityRun,
    activeRunningTurnId: runtime?.activeRunId ?? null,
    timelineEntries: EMPTY_TIMELINE_ENTRIES,
    timelineAnchorMessageId: null,
    setTimelineAnchor: noop,
    initialFollowEnd: readTimelinePosition(sideChatKey)?.atEnd !== false,
  });
  const attachTimelineViewport = useStableCallback((viewport: TimelineViewport) => {
    const filteredViewport: TimelineViewport = {
      ...viewport,
      subscribe: (listener) =>
        viewport.subscribe((navigation) => {
          if (
            navigation.source === "key" &&
            !viewport.scrollNode.contains(document.activeElement)
          ) {
            return;
          }
          listener(navigation);
        }),
    };
    return follow.attachTimelineViewport(filteredViewport);
  });
  const optimisticMessageId = props.optimisticMessages.at(-1)?.id ?? null;
  const answeredLessonCardAnswers =
    projection === null ? undefined : answeredCardAnswers(projection.messages);
  const previousOptimisticMessageId = useRef(optimisticMessageId);
  const scrollToEnd = useStableCallback(() => follow.scrollToEnd(true));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolls to this panel's own send after the commit that adds its optimistic row
  useLayoutEffect(() => {
    const previous = previousOptimisticMessageId.current;
    previousOptimisticMessageId.current = optimisticMessageId;
    if (optimisticMessageId !== null && optimisticMessageId !== previous) scrollToEnd();
  }, [optimisticMessageId, scrollToEnd]);

  const workspaceMutationId = useAtomValue(
    props.detailRef === null
      ? NO_WORKSPACE_MUTATION_ID_ATOM
      : environmentThreadDetails.workspaceMutationIdAtom(props.detailRef),
  );

  return (
    <div className="relative h-full min-h-0">
      <WorkspaceMutationIdContext value={workspaceMutationId}>
        <ThreadTimeline
          holdTimeline={false}
          lesson
          pendingApprovals={props.pendingApprovals}
          respondingRequestIds={props.respondingRequestIds}
          canOperateThread={props.canOperate}
          onRespondToApproval={props.onRespondToApproval}
          threadDetailRef={props.detailRef}
          answeredCardAnswers={answeredLessonCardAnswers}
          entriesInput={{
            optimisticMessages: props.optimisticMessages,
            ...(props.attachmentUrlById === undefined
              ? {}
              : { attachmentUrlById: props.attachmentUrlById }),
            ...(projection === null
              ? {}
              : {
                  attempts: projection.attempts,
                  nodes: projection.nodes,
                  plans: projection.plans,
                }),
          }}
          draftEntries={null}
          activeThreadKey={sideChatKey}
          syncing={props.detailLoading}
          detailLoading={props.detailLoading}
          citationRequest={props.citationRequest}
          citationHistory={citationHistory}
          onCiteAssistantText={props.onCiteAssistantText}
          onAskInSideChat={props.onAskInSideChat}
          askInSideChatPending={props.askInSideChatPending}
          isWorking={isWorking}
          runlessWorkActive={runlessWorkStartedAt !== null}
          activeTurnStartedAt={
            deriveActiveWorkStartedAt(activityRun, runtime, null) ?? runlessWorkStartedAt
          }
          onCancelWorktreeSetup={noop}
          listRef={props.listRef}
          runs={projection?.runs ?? []}
          latestRun={activityRun}
          runningRunId={runtime?.activeRunId ?? null}
          turnDiffSummaries={[]}
          activeThreadEnvironmentId={props.sideChatRef.environmentId}
          routeThreadKey={sideChatKey}
          threadFind={false}
          onOpenThread={props.onOpenThread}
          {...(props.onOpenSideChat === undefined ? {} : { onOpenSideChat: props.onOpenSideChat })}
          supportsConversationRollback={false}
          onRevertToTurnCount={noop}
          isRevertingCheckpoint={false}
          onImageExpand={(preview) =>
            openExpandedImagePreview(lessonKey, { ...preview, fill: true })
          }
          markdownCwd={workspaceRoot}
          resolvedTheme={resolvedTheme}
          timestampFormat={timestampFormat}
          workspaceRoot={workspaceRoot}
          anchorMessageId={null}
          onAnchorReady={noop}
          onAnchorSizeChanged={noop}
          contentInsetEndAdjustment={0}
          liveFollowEnabled={follow.timelineLiveFollowEnabled}
          onIsAtEndChange={follow.onIsAtEndChangeStable}
          onViewportAttach={attachTimelineViewport}
          onFooterGrow={follow.onTimelineFooterGrowStable}
          hideEmptyPlaceholder={props.detailLoading}
          emptyPlaceholder={
            props.label === null ? undefined : (
              // The question is the side chat's only prompt to type, so it reads at full muted strength.
              <span className="text-muted-foreground">
                What do you want to know about “{props.label}”?
              </span>
            )
          }
          emptyPlaceholderInset={0}
          footer={props.footer}
          {...(props.onSendAppMessage === undefined
            ? {}
            : { onSendAppMessage: props.onSendAppMessage })}
        />
      </WorkspaceMutationIdContext>
      {follow.showScrollToBottom ? (
        <ScrollToEndButton bottom={4} summary={null} onScrollToEnd={scrollToEnd} />
      ) : null}
    </div>
  );
}
