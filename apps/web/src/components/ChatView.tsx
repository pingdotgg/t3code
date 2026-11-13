import type { ChatViewProps } from "./chatView/chatViewTypes";
import { ChatViewScreen } from "./chatView/ChatViewScreen";
import { useChatViewState } from "./chatView/useChatViewState";

export default function ChatView(props: ChatViewProps) {
  const state = useChatViewState(props);
  return <ChatViewScreen state={state} />;
}
