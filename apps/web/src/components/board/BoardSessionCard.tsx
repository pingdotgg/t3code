import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import {
  deriveAgentPanelModel,
  foldSubagentActivities,
} from "@t3tools/client-runtime/state/subagentRuntime";
import type { EnvironmentConnectionPresentation } from "@t3tools/client-runtime/connection";
import type { CodexArtifactTemplate } from "@t3tools/client-runtime/codex-artifact-templates";
import {
  requestOlderThreadTurns,
  threadHasOlderTurns,
} from "@t3tools/client-runtime/state/threads";
import { threadWokeAt, type ThreadSnoozeShell } from "@t3tools/client-runtime/state/thread-settled";
import type {
  MessageId,
  OrchestrationThreadActivity,
  ScopedThreadRef,
  TurnId,
} from "@t3tools/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import { Link, useNavigate } from "@tanstack/react-router";
import { CircleDashedIcon, ExternalLinkIcon, GitBranchIcon, ServerIcon } from "lucide-react";
import * as Option from "effect/Option";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { BoardCard } from "../../board/board.logic";
import { useTheme } from "../../hooks/useTheme";
import { useThread } from "../../state/entities";
import { useComposerThreadDraft } from "../../composerDraftStore";
import { codexArtifactTemplatePromptToAppend } from "../ChatView.logic";
import { useDiffPanelStore } from "../../diffPanelStore";
import { useRightPanelStore } from "../../rightPanelStore";
import { useUiStateStore } from "../../uiStateStore";
import { resolveSidebarThreadStatus } from "../Sidebar.logic";
import { ProjectFavicon } from "../ProjectFavicon";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ChatComposer } from "../chat/ChatComposer";
import { ExpandedImageDialog } from "../chat/ExpandedImageDialog";
import type { ExpandedImagePreview } from "../chat/ExpandedImagePreview";
import { MessagesTimeline } from "../chat/MessagesTimeline";
import {
  boardComposerDraftCanBeRestored,
  resolveBoardTimelineWorkingState,
  useBoardThreadComposer,
} from "../chat/useThreadComposer";
import { useThreadTimeline } from "../chat/useThreadTimeline";
import { useInViewport } from "./useInViewport";
import { useEnvironmentThread } from "../../state/threads";
import { derivePhase } from "../../session-logic";

const statusLabels = {
  approval: "Approval",
  input: "Input",
  working: "Working",
  monitoring: "Monitoring",
  failed: "Failed",
  plan: "Plan Ready",
  woke: "Woke",
  completed: "Done",
  ready: "Ready",
} as const;

const statusStyles = {
  approval:
    "border-amber-500/35 bg-amber-500/8 text-amber-700 dark:bg-amber-500/16 dark:text-amber-300",
  input:
    "border-indigo-500/35 bg-indigo-500/8 text-indigo-600 dark:bg-indigo-500/16 dark:text-indigo-300",
  working: "border-sky-500/35 bg-sky-500/8 text-sky-600 dark:bg-sky-500/16 dark:text-sky-400",
  monitoring: "border-sky-500/35 bg-sky-500/8 text-sky-600 dark:bg-sky-500/16 dark:text-sky-400",
  failed: "border-red-500/35 bg-red-500/8 text-red-700 dark:bg-red-500/16 dark:text-red-300",
  plan: "border-violet-500/35 bg-violet-500/8 text-violet-600 dark:bg-violet-500/16 dark:text-violet-300",
  woke: "border-amber-500/35 bg-amber-500/8 text-amber-700 dark:bg-amber-500/16 dark:text-amber-300",
  completed:
    "border-emerald-500/35 bg-emerald-500/8 text-emerald-700 dark:bg-emerald-500/16 dark:text-emerald-300",
  ready: "border-border bg-muted/45 text-muted-foreground dark:bg-muted/45",
} as const;

const EMPTY_REVERT_TURN_COUNTS = new Map<MessageId, number>();
const EMPTY_ACTIVITIES: ReadonlyArray<OrchestrationThreadActivity> = [];
const NOOP = () => {};

export function resolveBoardCardVisitedAt(thread: ThreadSnoozeShell, now: string): string | null {
  return threadWokeAt(thread, { now }) ?? thread.latestTurn?.completedAt ?? null;
}

export function BoardCardDetailLoadFailure(props: { readonly error: string }) {
  return (
    <div
      className="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center"
      role="alert"
    >
      <p className="text-sm font-medium text-foreground">Could not load conversation</p>
      <p className="max-w-md text-xs text-muted-foreground">{props.error}</p>
      <p className="max-w-md text-[10px] text-muted-foreground/70">Trying again automatically…</p>
    </div>
  );
}

export type BoardThreadStatus =
  | ReturnType<typeof resolveSidebarThreadStatus>
  | "plan"
  | "woke"
  | "completed";

type BoardSessionCardProps = {
  readonly card: BoardCard<EnvironmentThreadShell, EnvironmentProject>;
  readonly environmentConnection: EnvironmentConnectionPresentation;
  readonly status: BoardThreadStatus;
};

export const BoardSessionCard = memo(function BoardSessionCard(props: BoardSessionCardProps) {
  const { card, environmentConnection, status } = props;
  const { project, thread } = card;
  const slotRef = useRef<HTMLDivElement | null>(null);
  const isNearViewport = useInViewport(slotRef, { rootMargin: "300px" });
  const [hasFocus, setHasFocus] = useState(false);
  const [chatRequestsMount, setChatRequestsMount] = useState(false);
  const runtime = thread.session?.providerName ?? String(thread.modelSelection.instanceId);
  const projectCwd = project?.workspaceRoot ?? thread.worktreePath ?? "";
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const markThreadVisited = useUiStateStore((state) => state.markThreadVisited);
  const composerDraft = useComposerThreadDraft(threadRef);
  const hasDraft = !boardComposerDraftCanBeRestored(composerDraft);
  const shouldMountChat = isNearViewport || hasFocus || hasDraft || chatRequestsMount;
  const acknowledgeThreadAttention = useCallback(() => {
    const visitedAt = resolveBoardCardVisitedAt(thread, new Date().toISOString());
    if (visitedAt) markThreadVisited(scopedThreadKey(threadRef), visitedAt);
  }, [markThreadVisited, thread, threadRef]);

  return (
    <article
      ref={slotRef}
      data-board-card={thread.id}
      onFocusCapture={() => {
        setHasFocus(true);
        acknowledgeThreadAttention();
      }}
      onPointerDownCapture={acknowledgeThreadAttention}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setHasFocus(false);
      }}
      className="flex h-[34rem] min-w-0 flex-col overflow-hidden rounded-xl border border-border/80 bg-card shadow-sm/5"
    >
      <header className="flex shrink-0 items-start gap-2 border-b border-border/60 px-3 py-2">
        <ProjectFavicon
          environmentId={thread.environmentId}
          cwd={projectCwd}
          faviconPath={project?.faviconPath}
          className="mt-0.5 size-4"
        />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <Tooltip>
              <TooltipTrigger
                render={<h3 className="min-w-0 flex-1 truncate text-xs font-semibold" />}
              >
                {thread.title}
              </TooltipTrigger>
              <TooltipPopup side="top">{thread.title}</TooltipPopup>
            </Tooltip>
            <Badge className={statusStyles[status]} size="sm" variant="outline">
              {statusLabels[status]}
            </Badge>
          </div>
          <div className="mt-1 flex min-w-0 items-center gap-2 overflow-hidden text-[10px] text-muted-foreground">
            <span className="inline-flex min-w-0 items-center gap-1 truncate">
              <ServerIcon aria-hidden className="size-3 shrink-0" />
              <span className="truncate">{card.environmentLabel ?? thread.environmentId}</span>
            </span>
            <span className="inline-flex min-w-0 items-center gap-1 truncate">
              <CircleDashedIcon aria-hidden className="size-3 shrink-0" />
              <Tooltip>
                <TooltipTrigger render={<span className="truncate" />}>
                  {runtime} · {thread.modelSelection.model}
                </TooltipTrigger>
                <TooltipPopup side="top">
                  {runtime} · {thread.modelSelection.model}
                </TooltipPopup>
              </Tooltip>
            </span>
            {thread.branch ? (
              <span className="inline-flex min-w-0 items-center gap-1 truncate">
                <GitBranchIcon aria-hidden className="size-3 shrink-0" />
                <span className="truncate">{thread.branch}</span>
              </span>
            ) : null}
          </div>
        </div>
        <Button
          render={
            <Link
              to="/$environmentId/$threadId"
              params={{ environmentId: thread.environmentId, threadId: thread.id }}
            />
          }
          size="icon-xs"
          variant="ghost"
          aria-label={`Open ${thread.title} in the full thread view`}
          className="mt-0.5 shrink-0 text-muted-foreground"
        >
          <ExternalLinkIcon className="size-3.5" />
        </Button>
      </header>
      {status === "input" ? (
        <Link
          to="/$environmentId/$threadId"
          params={{ environmentId: thread.environmentId, threadId: thread.id }}
          className="shrink-0 border-b border-indigo-500/20 bg-indigo-500/5 px-3 py-1.5 text-xs font-medium text-indigo-600 hover:bg-indigo-500/10 dark:text-indigo-300"
        >
          Answer requested input in the full thread
        </Link>
      ) : status === "plan" ? (
        <Link
          to="/$environmentId/$threadId"
          params={{ environmentId: thread.environmentId, threadId: thread.id }}
          className="shrink-0 border-b border-violet-500/20 bg-violet-500/5 px-3 py-1.5 text-xs font-medium text-violet-600 hover:bg-violet-500/10 dark:text-violet-300"
        >
          Open the full thread to implement this plan
        </Link>
      ) : null}
      {shouldMountChat ? (
        <BoardCardChatSurface
          threadRef={threadRef}
          thread={thread}
          environmentLabel={card.environmentLabel ?? thread.environmentId}
          environmentConnection={environmentConnection}
          onMountRequestChange={setChatRequestsMount}
        />
      ) : (
        <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground/55">
          Scroll into view to load this conversation
        </div>
      )}
    </article>
  );
}, boardSessionCardPropsEqual);

function boardSessionCardPropsEqual(
  previous: BoardSessionCardProps,
  next: BoardSessionCardProps,
): boolean {
  return (
    previous.card.thread === next.card.thread &&
    previous.card.project === next.card.project &&
    previous.card.environmentLabel === next.card.environmentLabel &&
    previous.environmentConnection === next.environmentConnection &&
    previous.status === next.status
  );
}

const BoardCardChatSurface = memo(function BoardCardChatSurface(props: {
  readonly threadRef: ScopedThreadRef;
  readonly thread: EnvironmentThreadShell;
  readonly environmentLabel: string;
  readonly environmentConnection: EnvironmentConnectionPresentation;
  readonly onMountRequestChange: (requested: boolean) => void;
}) {
  const { threadRef, thread, environmentLabel, environmentConnection, onMountRequestChange } =
    props;
  const fullThread = useThread(threadRef);
  const threadState = useEnvironmentThread(threadRef.environmentId, threadRef.threadId);
  if (fullThread === null) {
    const detailError = Option.getOrNull(threadState.error);
    if (detailError !== null) {
      return <BoardCardDetailLoadFailure error={detailError} />;
    }
    return (
      <div
        role="status"
        className="flex flex-1 items-center justify-center text-xs text-muted-foreground/55"
      >
        {threadState.status === "deleted"
          ? "Conversation no longer available"
          : "Loading conversation…"}
      </div>
    );
  }

  return (
    <BoardCardChatContent
      threadRef={threadRef}
      thread={thread}
      fullThread={fullThread}
      threadState={threadState}
      environmentLabel={environmentLabel}
      environmentConnection={environmentConnection}
      onMountRequestChange={onMountRequestChange}
    />
  );
});

const BoardCardChatContent = memo(function BoardCardChatContent(props: {
  readonly threadRef: ScopedThreadRef;
  readonly thread: EnvironmentThreadShell;
  readonly fullThread: NonNullable<ReturnType<typeof useThread>>;
  readonly threadState: ReturnType<typeof useEnvironmentThread>;
  readonly environmentLabel: string;
  readonly environmentConnection: EnvironmentConnectionPresentation;
  readonly onMountRequestChange: (requested: boolean) => void;
}) {
  const {
    threadRef,
    thread,
    fullThread,
    threadState,
    environmentLabel,
    environmentConnection,
    onMountRequestChange,
  } = props;
  const navigate = useNavigate();
  const threadActivities = fullThread.activities ?? EMPTY_ACTIVITIES;
  const agentSessionLive = derivePhase(fullThread.session) !== "disconnected";
  const agentPanelModel = useMemo(
    () =>
      deriveAgentPanelModel({
        agents: foldSubagentActivities(threadActivities, { sessionLive: agentSessionLive }),
      }),
    [agentSessionLive, threadActivities],
  );
  const { resolvedTheme } = useTheme();
  const legendListRef = useRef<LegendListRef | null>(null);
  const [expandedImage, setExpandedImage] = useState<ExpandedImagePreview | null>(null);
  const [liveFollowEnabled, setLiveFollowEnabled] = useState(true);
  const anchorRef = useRef<MessageId | null>(null);
  const loadEarlier = useMemo(() => {
    if (!threadHasOlderTurns(threadState)) return null;
    return {
      loading: threadState.page._tag === "Some" && threadState.page.value.loadingOlder,
      onLoadEarlier: () => requestOlderThreadTurns(threadRef.environmentId, threadRef.threadId),
    };
  }, [threadRef.environmentId, threadRef.threadId, threadState]);

  const onExpandTimelineImage = useCallback((preview: ExpandedImagePreview) => {
    setExpandedImage(preview);
  }, []);
  const openCanonicalThread = useCallback(() => {
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: threadRef.environmentId, threadId: threadRef.threadId },
    });
  }, [navigate, threadRef]);
  const onFileOpen = openCanonicalThread;
  const {
    chatComposerProps,
    composerRef,
    localSendStartedAt,
    hasRetainedOptimisticMessages,
    timelineMessages,
    timelineAnchorMessageId,
    clearTimelineAnchor,
  } = useBoardThreadComposer({
    threadRef,
    thread: fullThread,
    summary: thread,
    environmentLabel,
    environmentConnection,
    resolvedTheme,
    onExpandImage: onExpandTimelineImage,
    onFileOpen,
  });
  const onOpenAgents = useCallback(() => {
    useRightPanelStore.getState().open(threadRef, "agents");
    openCanonicalThread();
  }, [openCanonicalThread, threadRef]);
  const onUseArtifactTemplate = useCallback(
    (template: CodexArtifactTemplate) => {
      const composer = composerRef.current;
      if (composer) {
        const currentDraft = composer.getSendContext().prompt;
        const prompt = codexArtifactTemplatePromptToAppend(currentDraft, template);
        if (prompt !== null && !composer.insertTextAtEnd(prompt, { ensureLeadingBoundary: true })) {
          toastManager.add({
            type: "error",
            title: "Unable to add to chat",
            description: "The composer is busy; try again once it is ready.",
          });
          return;
        }
      }
      openCanonicalThread();
    },
    [composerRef, openCanonicalThread],
  );
  const {
    timelineEntries,
    latestTurn,
    runningTurnId,
    isWorking,
    activeTurnStartedAt,
    turnDiffSummaryByAssistantMessageId,
    markdownCwd,
    workspaceRoot,
    resolvedTheme: timelineTheme,
    timestampFormat,
    skills,
    routeThreadKey,
    activeThreadEnvironmentId,
  } = useThreadTimeline({
    threadRef,
    thread: fullThread,
    timelineMessages,
    resolvedTheme,
  });
  const timelineWorkingState = resolveBoardTimelineWorkingState({
    serverIsWorking: isWorking,
    serverActiveTurnStartedAt: activeTurnStartedAt,
    isLocalSendBusy: chatComposerProps.isSendBusy,
    localSendStartedAt,
  });

  const onOpenTurnDiff = useCallback(
    (turnId: TurnId, filePath?: string) => {
      useDiffPanelStore.getState().selectTurn(threadRef, turnId, filePath);
      useRightPanelStore.getState().open(threadRef, "diff");
      void navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: threadRef.environmentId, threadId: threadRef.threadId },
      });
    },
    [navigate, threadRef],
  );
  const onAnchorReady = useCallback((messageId: MessageId, anchorIndex: number) => {
    if (anchorRef.current === messageId) return;
    anchorRef.current = messageId;
    void legendListRef.current?.scrollToIndex({
      index: anchorIndex,
      animated: true,
      viewPosition: 0,
      viewOffset: 8,
    });
  }, []);
  useEffect(() => {
    if (timelineAnchorMessageId === null) return;
    anchorRef.current = null;
    setLiveFollowEnabled(true);
  }, [timelineAnchorMessageId]);
  const onManualNavigation = useCallback(() => {
    setLiveFollowEnabled(false);
  }, []);
  const onIsAtEndChange = useCallback(
    (isAtEnd: boolean) => {
      if (!isAtEnd) return;
      setLiveFollowEnabled(true);
      clearTimelineAnchor();
    },
    [clearTimelineAnchor],
  );
  useEffect(() => {
    onMountRequestChange(
      chatComposerProps.isSendBusy || !liveFollowEnabled || hasRetainedOptimisticMessages,
    );
    return () => onMountRequestChange(false);
  }, [
    chatComposerProps.isSendBusy,
    hasRetainedOptimisticMessages,
    liveFollowEnabled,
    onMountRequestChange,
  ]);

  return (
    <>
      <div className="min-h-0 flex-1">
        <MessagesTimeline
          density="compact"
          agentPanelModel={agentPanelModel}
          onOpenAgents={onOpenAgents}
          isWorking={timelineWorkingState.isWorking}
          activeTurnStartedAt={timelineWorkingState.activeTurnStartedAt}
          listRef={legendListRef}
          timelineEntries={timelineEntries}
          latestTurn={latestTurn}
          runningTurnId={runningTurnId}
          turnDiffSummaryByAssistantMessageId={turnDiffSummaryByAssistantMessageId}
          routeThreadKey={routeThreadKey}
          onOpenTurnDiff={onOpenTurnDiff}
          revertTurnCountByUserMessageId={EMPTY_REVERT_TURN_COUNTS}
          onRevertUserMessage={NOOP}
          isRevertingCheckpoint={false}
          onImageExpand={onExpandTimelineImage}
          onFileOpen={onFileOpen}
          onUseArtifactTemplate={onUseArtifactTemplate}
          openingVideoAttachmentId={null}
          activeThreadEnvironmentId={activeThreadEnvironmentId}
          markdownCwd={markdownCwd}
          resolvedTheme={timelineTheme}
          timestampFormat={timestampFormat}
          workspaceRoot={workspaceRoot}
          skills={skills}
          anchorMessageId={timelineAnchorMessageId}
          onAnchorReady={onAnchorReady}
          contentInsetEndAdjustment={0}
          liveFollowEnabled={liveFollowEnabled}
          onIsAtEndChange={onIsAtEndChange}
          onManualNavigation={onManualNavigation}
          topFadeEnabled={false}
          loadEarlier={loadEarlier}
        />
      </div>
      {expandedImage ? (
        <ExpandedImageDialog preview={expandedImage} onClose={() => setExpandedImage(null)} />
      ) : null}
      <div className="shrink-0 border-t border-border/60 px-1.5 py-1">
        <ChatComposer {...chatComposerProps} embedded />
      </div>
    </>
  );
});
