import { isMacPlatform } from "./lib/utils";

export interface TerminalClipboardShortcutEvent {
  type?: string;
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

function normalizeKey(key: string): string {
  return key.toLowerCase();
}

function isKeydownEvent(event: TerminalClipboardShortcutEvent): boolean {
  return event.type === undefined || event.type === "keydown";
}

export function isTerminalCopyShortcut(
  event: TerminalClipboardShortcutEvent,
  hasSelection: boolean,
  platform = navigator.platform,
): boolean {
  if (!isKeydownEvent(event)) return false;

  const key = normalizeKey(event.key);
  if (isMacPlatform(platform)) {
    return (
      hasSelection &&
      key === "c" &&
      event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.shiftKey
    );
  }

  if (
    key === "insert" &&
    event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !event.shiftKey
  ) {
    return hasSelection;
  }

  if (key !== "c" || !event.ctrlKey || event.metaKey || event.altKey) {
    return false;
  }

  if (event.shiftKey) {
    return true;
  }

  return hasSelection;
}

export function isTerminalPasteShortcut(
  event: TerminalClipboardShortcutEvent,
  platform = navigator.platform,
): boolean {
  if (!isKeydownEvent(event)) return false;

  const key = normalizeKey(event.key);
  if (isMacPlatform(platform)) {
    return (
      key === "v" &&
      event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.shiftKey
    );
  }

  if (
    key === "insert" &&
    event.shiftKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey
  ) {
    return true;
  }

  return (
    key === "v" &&
    event.ctrlKey &&
    event.shiftKey &&
    !event.metaKey &&
    !event.altKey
  );
}

function fallbackWriteClipboardText(text: string): void {
  const activeElement =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.setAttribute("aria-hidden", "true");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  document.body.appendChild(textarea);
  textarea.select();
  try {
    document.execCommand("copy");
  } finally {
    textarea.remove();
    activeElement?.focus();
  }
}

export async function writeTextToTerminalClipboard(text: string): Promise<void> {
  if (typeof window !== "undefined" && window.desktopBridge?.writeClipboardText) {
    await window.desktopBridge.writeClipboardText(text);
    return;
  }

  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  if (typeof document !== "undefined") {
    fallbackWriteClipboardText(text);
    return;
  }

  throw new Error("Clipboard write is not available");
}

export async function readTextFromTerminalClipboard(): Promise<string> {
  if (typeof window !== "undefined" && window.desktopBridge?.readClipboardText) {
    return window.desktopBridge.readClipboardText();
  }

  if (typeof navigator !== "undefined" && navigator.clipboard?.readText) {
    return navigator.clipboard.readText();
  }

  throw new Error("Clipboard read is not available");
}
