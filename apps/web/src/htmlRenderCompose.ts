import type { ScopedThreadRef } from "@t3tools/contracts";

/**
 * Carries text from an inline page's own button (for example "Done" on a review page) to the
 * open chat's message box. The page lives in the timeline, far from the composer, so the chat
 * view listens here and accepts only text from pages in the thread it shows. Nothing is sent.
 */
export interface HtmlRenderComposeRequest {
  readonly threadRef: ScopedThreadRef | undefined;
  readonly text: string;
}

type Listener = (request: HtmlRenderComposeRequest) => boolean;

const listeners = new Set<Listener>();

export function onHtmlRenderCompose(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** True when a chat view took the text. */
export function requestHtmlRenderCompose(request: HtmlRenderComposeRequest): boolean {
  for (const listener of listeners) {
    if (listener(request)) return true;
  }
  return false;
}
