"use client";

import type { KeybindingCommand } from "@t3tools/contracts";

/**
 * Typed window-event bus for preview-panel actions. Lets the global
 * keybinding handler in `routes/_chat.tsx` reach `ChatView`'s URL-aware
 * arbitration and the visible browser tab without prop drilling or shared refs.
 */
export type PreviewAction = Extract<KeybindingCommand, `preview.${string}`>;

export const isPreviewAction = (command: KeybindingCommand): command is PreviewAction =>
  command.startsWith("preview.");

const EVENT_NAME = "t3code:preview-action";

export function dispatchPreviewAction(action: PreviewAction): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<PreviewAction>(EVENT_NAME, { detail: action }));
}

export function subscribePreviewAction(listener: (action: PreviewAction) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<PreviewAction>).detail;
    if (typeof detail === "string") listener(detail);
  };
  window.addEventListener(EVENT_NAME, handler);
  return () => window.removeEventListener(EVENT_NAME, handler);
}

// Long enough for a new tab to mount, short enough that a tab first shown
// later (after a thread switch) does not take focus.
const URL_FOCUS_REQUEST_TTL_MS = 2_000;
let pendingUrlFocus: { readonly tabId: string; readonly requestedAt: number } | null = null;

/**
 * Asks the browser view to focus its address bar once `tabId` is showing.
 * A new tab is not mounted yet when it is created, so the request waits.
 */
export function requestPreviewUrlFocus(tabId: string): void {
  pendingUrlFocus = { tabId, requestedAt: Date.now() };
}

export function consumePreviewUrlFocus(tabId: string): boolean {
  if (pendingUrlFocus?.tabId !== tabId) return false;
  const fresh = Date.now() - pendingUrlFocus.requestedAt < URL_FOCUS_REQUEST_TTL_MS;
  pendingUrlFocus = null;
  return fresh;
}
