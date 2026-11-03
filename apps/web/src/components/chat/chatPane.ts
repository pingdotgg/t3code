import { createContext } from "react";

import type { ChatPaneDirection } from "../../chatPanesStore";

/** What a split pane tells the ChatView inside it; null outside a split. */
export interface ChatPaneContextValue {
  readonly direction: ChatPaneDirection;
  /** The pane's root, which contains fixed descendants such as the right panel sheet. */
  readonly element: HTMLElement | null;
  /** Too narrow for the right panel beside the chat, so it opens as a sheet. */
  readonly narrow: boolean;
  /** One pane keeps other threads' terminals mounted; the rest mount only their own. */
  readonly hostsHiddenTerminals: boolean;
  /** Threads the other panes show; their own panes mount those terminals. */
  readonly otherPaneThreadKeys: ReadonlySet<string>;
  readonly swap: () => void;
  readonly setDirection: (direction: ChatPaneDirection) => void;
  readonly close: () => void;
}

export const ChatPaneContext = createContext<ChatPaneContextValue | null>(null);
