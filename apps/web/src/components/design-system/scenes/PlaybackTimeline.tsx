import { EnvironmentId, type ProviderApprovalDecision } from "@t3tools/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import { useRef, useState } from "react";

import { MessagesTimeline, type TimelinePendingRequest } from "../../chat/MessagesTimeline";
import { pendingApprovalSlotLabel } from "../../chat/MessagesTimeline.logic";
import { playbackTimeline, type PlaybackState, type playbackComposerRequests } from "./playback";

const PLAYBACK_ENVIRONMENT_ID = EnvironmentId.make("playback-environment");
const noop = () => {};

function pendingRequestAt(requests: ReturnType<typeof playbackComposerRequests>) {
  return requests.approvals[0]?.createdAt ?? requests.userInputs[0]?.createdAt ?? null;
}

/**
 * The real MessagesTimeline, fed the way ChatView feeds it, over the player's
 * state. Approval actions and disclosures work as they do while a turn streams.
 */
export function PlaybackTimeline({
  state,
  requests,
  theme,
  onApprove,
}: {
  state: PlaybackState;
  requests: ReturnType<typeof playbackComposerRequests>;
  theme: "light" | "dark";
  onApprove: (requestId: string, decision: ProviderApprovalDecision) => void;
}) {
  const listRef = useRef<LegendListRef | null>(null);
  const { entries, latestRun, running, compacting, runningForMs } = playbackTimeline(state);
  // The live header counts wall-clock time, so anchor it that far before now.
  const [openedAt] = useState(() => Date.now());
  // A paused header measures turn start to request, so it uses the scene's own
  // clock for both; the live header counts on from now instead.
  const activeTurnStartedAt = running
    ? pendingRequestAt(requests) !== null
      ? (latestRun?.startedAt ?? null)
      : new Date(openedAt - runningForMs).toISOString()
    : null;
  // The working header pauses on the first request, as ChatView reports it.
  const approval = requests.approvals[0];
  const question = requests.userInputs[0];
  const pendingRequest: TimelinePendingRequest | null = approval
    ? { kind: "approval", label: pendingApprovalSlotLabel(approval), createdAt: approval.createdAt }
    : question?.questions[0]
      ? { kind: "question", label: question.questions[0].question, createdAt: question.createdAt }
      : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <MessagesTimeline
        emptyPlaceholderInset={0}
        isWorking={running}
        isCompacting={compacting}
        activeTurnStartedAt={activeTurnStartedAt}
        pendingRequest={pendingRequest}
        pendingApprovals={requests.approvals}
        canOperateThread
        onRespondToApproval={async (requestId, decision) => onApprove(requestId, decision)}
        listRef={listRef}
        timelineEntries={entries}
        latestRun={latestRun}
        runningRunId={running ? (latestRun?.runId ?? null) : null}
        turnDiffSummaries={[]}
        runs={[]}
        routeThreadKey="design-system:playback"
        onOpenTurnDiff={noop}
        onOpenThread={noop}
        onForkFromRun={async () => {}}
        supportsConversationRollback={false}
        onRevertToTurnCount={noop}
        isRevertingCheckpoint={false}
        onImageExpand={noop}
        activeThreadEnvironmentId={PLAYBACK_ENVIRONMENT_ID}
        markdownCwd={undefined}
        resolvedTheme={theme}
        timestampFormat="locale"
        workspaceRoot="/Users/julius/Development/t3code"
        anchorMessageId={null}
        onAnchorReady={noop}
        onAnchorSizeChanged={noop}
        contentInsetEndAdjustment={0}
        liveFollowEnabled
        onIsAtEndChange={noop}
      />
    </div>
  );
}
