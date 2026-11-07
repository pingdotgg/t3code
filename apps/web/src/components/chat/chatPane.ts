import { createContext } from "react";

/** What a split pane tells the ChatView inside it; null outside a split. */
export interface ChatPaneContextValue {
  /** The pane's root, which contains fixed descendants such as the right panel sheet. */
  readonly element: HTMLElement | null;
  /** Too narrow for the right panel beside the chat, so it opens as a sheet. */
  readonly narrow: boolean;
  /** One pane keeps other threads' terminals mounted; the other mounts only its own. */
  readonly hostsHiddenTerminals: boolean;
  /** Threads the other pane shows; that pane mounts those terminals. */
  readonly otherPaneThreadKeys: ReadonlySet<string>;
  readonly close: () => void;
}

export const ChatPaneContext = createContext<ChatPaneContextValue | null>(null);
