import { createContext } from "react";

/**
 * True for a thread kept mounted under Settings or Usage, shown in an unfocused split pane, or
 * shown as a side chat in its parent's panel; its global shortcuts and listeners stand down.
 */
export const BackgroundThreadContext = createContext(false);

/** Whether `target` sits in a side chat, an unfocused split pane, or a thread under Settings. */
export function isInBackgroundThreadView(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest("[data-side-chat-pane], [data-background-thread-view]") !== null
  );
}
