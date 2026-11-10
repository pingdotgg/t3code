import { createContext, type ReactNode } from "react";

export const SplitChatPaneControlsContext = createContext<ReactNode>(null);
// Only the active split pane takes window keyboard shortcuts.
export const SplitChatPaneActiveContext = createContext(true);
