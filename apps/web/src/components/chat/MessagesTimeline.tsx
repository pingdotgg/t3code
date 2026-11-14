import { ThreadFindTimelineContext } from "./ThreadFindProvider";
import { useContext } from "react";
import { ConversationTimeline } from "./conversationTimeline";
import type { MessagesTimelineProps } from "./messagesTimelineShared";

export function MessagesTimeline(props: MessagesTimelineProps) {
  const find = useContext(ThreadFindTimelineContext);
  const findOpen = find?.findOpen ?? props.findOpen;
  return (
    <ConversationTimeline
      {...props}
      {...find}
      liveFollowEnabled={!findOpen && props.liveFollowEnabled}
    />
  );
}

export type { MessagesTimelineHistoryControls, MessagesTimelineProps } from "./messagesTimelineShared";
