import { useRef, useState } from "react";
import type { LegendListRef } from "@legendapp/list/react";
import { MessageId, type EnvironmentId } from "@t3tools/contracts";
import { useClientSettings } from "~/hooks/useSettings";
import { useTheme } from "~/hooks/useTheme";
import { definePluginComponent } from "~/plugins/features";
import type { TimelineEntry } from "~/session-logic";
import { MessagesTimeline } from "./MessagesTimeline";
import { ChatCanvasContext } from "./ChatCanvasContext";

const noop = () => {};
const empty: readonly never[] = [];

export interface ConversationMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly createdAt: string;
  readonly streaming?: boolean;
}

export interface ConversationTimelineProps {
  /** Stable identity of this separate conversation, never the source thread's key. */
  readonly conversationId: string;
  readonly environmentId: EnvironmentId;
  readonly messages: readonly ConversationMessage[];
  readonly pending?: boolean;
}

/** Reuses the real virtualized timeline and message rows without main-thread mutations. */
function BuiltinConversationTimeline({
  conversationId,
  environmentId,
  messages,
  pending = false,
}: ConversationTimelineProps) {
  const listRef = useRef<LegendListRef | null>(null);
  const [liveFollowEnabled, setLiveFollowEnabled] = useState(true);
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const { resolvedTheme } = useTheme();
  const timelineEntries = messages.map((message): TimelineEntry => ({
    kind: "message",
    id: message.id,
    createdAt: message.createdAt,
    message: {
      ...message,
      id: MessageId.make(message.id),
      streaming: message.streaming ?? false,
      runId: null,
      updatedAt: message.createdAt,
    },
  }));
  return (
    <ChatCanvasContext value={null}>
      <MessagesTimeline
        threadRef={null}
        listRef={listRef}
        timelineEntries={timelineEntries}
        isWorking={pending}
        latestRun={null}
        turnDiffSummaries={empty}
        routeThreadKey={`conversation:${environmentId}:${conversationId}`}
        onOpenTurnDiff={noop}
        onOpenThread={noop}
        onForkFromRun={async () => {}}
        supportsConversationRollback={false}
        onRevertToTurnCount={noop}
        isRevertingCheckpoint={false}
        onImageExpand={noop}
        activeThreadEnvironmentId={environmentId}
        markdownCwd={undefined}
        workspaceRoot={undefined}
        resolvedTheme={resolvedTheme}
        timestampFormat={timestampFormat}
        runs={empty}
        anchorMessageId={null}
        onAnchorReady={noop}
        onAnchorSizeChanged={noop}
        contentInsetEndAdjustment={0}
        onIsAtEndChange={setLiveFollowEnabled}
        liveFollowEnabled={liveFollowEnabled}
        hideEmptyPlaceholder
        emptyPlaceholderInset={0}
      />
    </ChatCanvasContext>
  );
}

export const ConversationTimeline = definePluginComponent(
  "component:components/chat/ConversationTimeline/ConversationTimeline",
  BuiltinConversationTimeline,
);
