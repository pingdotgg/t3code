"use client";

/**
 * Typed window-event bus announcing that a ChatComposer has mounted and its
 * shared handle (ComposerHandleContext) is populated. Lets app-level features
 * that navigate toward a thread — the screenshot hotkey — attach as soon as
 * the destination composer exists, without polling.
 */
const EVENT_NAME = "t3code:composer-ready";

export function announceComposerReady(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(EVENT_NAME));
}

export function onComposerReady(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = () => listener();
  window.addEventListener(EVENT_NAME, handler);
  return () => window.removeEventListener(EVENT_NAME, handler);
}
