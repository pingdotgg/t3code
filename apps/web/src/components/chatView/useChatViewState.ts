import type { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import type { ChatViewProps } from "./chatViewTypes";
import { useChatViewCore } from "./useChatViewCore";
import { useChatViewThreadState } from "./useChatViewThreadState";
import { useChatViewPanelsState } from "./useChatViewPanelsState";
import { useChatViewActions } from "./useChatViewActions";
import { useChatViewPanelActions } from "./useChatViewPanelActions";
import { useChatViewComposerState } from "./useChatViewComposerState";
import { useChatViewSendState } from "./useChatViewSendState";

/**
 * Runs the ChatView state hooks in their original order, so React hook slots stay stable.
 */
export function useChatViewState(props: ChatViewProps) {
  const s1 = useChatViewCore(props);
  const s2 = useChatViewThreadState(s1);
  const s3 = useChatViewPanelsState(s2);
  const s4 = useChatViewActions(s3);
  const s5 = useChatViewPanelActions(s4);
  const s6 = useChatViewComposerState(s5);
  const s7 = useChatViewSendState(s6);
  return s7;
}

export type ChatViewState = ReturnType<typeof useChatViewState>;
