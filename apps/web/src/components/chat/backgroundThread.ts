import { createContext } from "react";

/**
 * True for a thread that is not the page's own: one kept mounted under Settings or Usage, or a
 * chat embedded in another thread's panel (a side chat or a pipeline coordinator). Its global
 * shortcuts and listeners stand down.
 */
export const BackgroundThreadContext = createContext(false);

/** True inside a chat embedded in another thread's panel (the pipeline coordinator tab). */
export const EmbeddedChatContext = createContext(false);

/** Events from inside an embedded chat belong to it, not to the page's own thread. */
export function isFromEmbeddedChat(event: Event): boolean {
  return event.target instanceof Element && event.target.closest("[data-embedded-chat]") !== null;
}
