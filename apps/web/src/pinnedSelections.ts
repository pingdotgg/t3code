import { ASSISTANT_CITATION_MAX_TEXT_LENGTH } from "@t3tools/contracts";

import {
  captureAssistantTextSelection,
  createAssistantTextSelector,
  findAssistantCitationText,
  resolveAssistantCitationRange,
  type AssistantTextSelector,
} from "./lib/assistantTextSelection";

export const PINNED_SELECTIONS_VERSION = 1;
export const MAX_PINNED_SELECTIONS = 40;
export const PINNED_SELECTION_HIGHLIGHT_NAME = "t3-pinned-selection";
const PINNED_SELECTION_PREVIEW_WORDS = 6;
const PINNED_SELECTION_CONTEXT_LIMIT = 64;

const PLAIN_EXCLUDED_SELECTOR =
  "button, input, textarea, select, [role=button], [contenteditable], [data-thread-find-ignore], script, style, svg";
const PLAIN_BLOCK_SELECTOR = "p, div, li, pre, blockquote, h1, h2, h3, h4, h5, h6, tr, br";

export interface PinnedSelection extends AssistantTextSelector {
  readonly id: string;
  readonly messageId: string;
  readonly createdAt: string;
}

export type PinnedSelectionDraft = Omit<PinnedSelection, "id" | "createdAt">;

export function pinnedSelectionPreview(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  const words = normalized.split(" ").filter((word) => word.length > 0);
  if (words.length <= PINNED_SELECTION_PREVIEW_WORDS) return normalized;
  return `${words.slice(0, PINNED_SELECTION_PREVIEW_WORDS).join(" ")}…`;
}

export function settledPinsToastTitle(count: number): string | null {
  if (count <= 0) return null;
  return count === 1 ? "This thread still has a pin" : `This thread still has ${count} pins`;
}

export function insertPinnedSelection(
  selections: readonly PinnedSelection[],
  draft: PinnedSelectionDraft,
  id: string,
  createdAt: string,
): { readonly selections: readonly PinnedSelection[]; readonly pin: PinnedSelection } {
  const existing = selections.find(
    (pin) =>
      pin.messageId === draft.messageId &&
      pin.start === draft.start &&
      pin.end === draft.end &&
      pin.text === draft.text,
  );
  if (existing) return { selections, pin: existing };
  const pin: PinnedSelection = { ...draft, id, createdAt };
  return { selections: [...selections, pin].slice(-MAX_PINNED_SELECTIONS), pin };
}

function sanitizePinnedSelectionsByThread(
  value: unknown,
): Record<string, readonly PinnedSelection[]> {
  if (!value || typeof value !== "object") return {};
  const next: Record<string, readonly PinnedSelection[]> = {};
  for (const [threadKey, entries] of Object.entries(value)) {
    if (!threadKey || !Array.isArray(entries)) continue;
    const pins: PinnedSelection[] = [];
    for (const entry of entries) {
      const pin = sanitizePinnedSelection(entry);
      if (pin) pins.push(pin);
    }
    if (pins.length > 0) next[threadKey] = pins.slice(-MAX_PINNED_SELECTIONS);
  }
  return next;
}

/** Unknown future versions are dropped. A missing version still accepts this shape. */
export function pinnedSelectionsFromPersisted(
  version: unknown,
  value: unknown,
): Record<string, readonly PinnedSelection[]> {
  if (version !== undefined && version !== PINNED_SELECTIONS_VERSION) return {};
  return sanitizePinnedSelectionsByThread(value);
}

function sanitizePinnedSelection(value: unknown): PinnedSelection | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Record<string, unknown>;
  const id = typeof entry.id === "string" ? entry.id : "";
  const messageId = typeof entry.messageId === "string" ? entry.messageId : "";
  const text = typeof entry.text === "string" ? entry.text : "";
  const prefix = typeof entry.prefix === "string" ? entry.prefix : "";
  const suffix = typeof entry.suffix === "string" ? entry.suffix : "";
  const createdAt = typeof entry.createdAt === "string" ? entry.createdAt : "";
  const start = entry.start;
  const end = entry.end;
  if (
    id.length === 0 ||
    messageId.length === 0 ||
    text.trim().length === 0 ||
    text.length > ASSISTANT_CITATION_MAX_TEXT_LENGTH ||
    createdAt.length === 0 ||
    !Number.isFinite(Date.parse(createdAt)) ||
    typeof start !== "number" ||
    typeof end !== "number" ||
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end <= start
  ) {
    return null;
  }
  return {
    id,
    messageId,
    text,
    start,
    end,
    prefix: prefix.slice(0, PINNED_SELECTION_CONTEXT_LIMIT),
    suffix: suffix.slice(0, PINNED_SELECTION_CONTEXT_LIMIT),
    createdAt,
  };
}

type TextChunk = { readonly node: Text; readonly start: number; readonly end: number };

function readPlainMessageText(root: HTMLElement) {
  const parts: string[] = [];
  const chunks: TextChunk[] = [];
  let length = 0;

  const visit = (node: Node) => {
    if (node.nodeType === 3) {
      const text = node as Text;
      if (text.data.length === 0) return;
      chunks.push({ node: text, start: length, end: length + text.data.length });
      parts.push(text.data);
      length += text.data.length;
      return;
    }
    if (node.nodeType !== 1) return;
    const element = node as Element;
    if (element.matches(PLAIN_EXCLUDED_SELECTOR)) return;
    const block = element.matches(PLAIN_BLOCK_SELECTOR);
    if (block && length > 0 && parts[parts.length - 1] !== "\n") {
      parts.push("\n");
      length += 1;
    }
    for (const child of element.childNodes) visit(child);
  };

  visit(root);
  return { text: parts.join(""), chunks };
}

function rawTextOffset(text: string, normalizedOffset: number): number {
  let offset = 0;
  for (const match of text.matchAll(/\s+|\S+/g)) {
    const token = match[0]!;
    const whitespace = /\s/.test(token[0]!);
    const tokenLength = whitespace ? 1 : token.length;
    if (normalizedOffset <= offset + tokenLength) {
      return (
        match.index +
        (whitespace && normalizedOffset > offset ? token.length : normalizedOffset - offset)
      );
    }
    offset += tokenLength;
  }
  return text.length;
}

function capturePlainSelection(
  root: HTMLElement,
  selection: Selection,
): AssistantTextSelector | null {
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  const stream = readPlainMessageText(root);
  let rawStart: number | null = null;
  let rawEnd = 0;
  for (const chunk of stream.chunks) {
    if (!range.intersectsNode(chunk.node)) continue;
    const start = range.startContainer === chunk.node ? range.startOffset : 0;
    const end = range.endContainer === chunk.node ? range.endOffset : chunk.node.length;
    if (start >= end) continue;
    rawStart ??= chunk.start + start;
    rawEnd = chunk.start + end;
  }
  if (rawStart === null) return null;
  return createAssistantTextSelector(stream.text, rawStart, rawEnd);
}

function resolvePlainRange(root: HTMLElement, selector: AssistantTextSelector): Range | null {
  const stream = readPlainMessageText(root);
  const match = findAssistantCitationText(stream.text, selector);
  if (match === null) return null;
  const start = rawTextOffset(stream.text, match.start);
  const end = rawTextOffset(stream.text, match.end);
  const first = stream.chunks.find((chunk) => chunk.end > start);
  const last = stream.chunks.findLast((chunk) => chunk.start < end);
  if (!first || !last) return null;
  const range = root.ownerDocument.createRange();
  range.setStart(first.node, Math.max(0, Math.min(first.node.length, start - first.start)));
  range.setEnd(last.node, Math.max(0, Math.min(last.node.length, end - last.start)));
  return range.collapsed ? null : range;
}

export function capturePinnedMessageSelection(
  viewport: HTMLElement,
  selection: Selection | null,
): PinnedSelectionDraft | null {
  if (selection === null || selection.isCollapsed || selection.rangeCount !== 1) return null;
  const anchor = selection.anchorNode;
  if (anchor === null || !viewport.contains(anchor)) return null;
  const element = anchor instanceof Element ? anchor : anchor.parentElement;
  const message = element?.closest<HTMLElement>("[data-message-id]");
  if (!message || !viewport.contains(message)) return null;
  const messageId = message.dataset.messageId;
  if (!messageId) return null;

  const assistantSource = message.querySelector("[data-assistant-citation-source]");
  const selector = assistantSource
    ? (() => {
        const captured = captureAssistantTextSelection(viewport, selection);
        return captured?.source.dataset.assistantCitationSource === messageId
          ? captured.selector
          : null;
      })()
    : capturePlainSelection(
        message.querySelector<HTMLElement>("[data-thread-find-text]") ?? message,
        selection,
      );
  if (selector === null || selector.text.length > ASSISTANT_CITATION_MAX_TEXT_LENGTH) return null;
  return { messageId, ...selector };
}

export function resolvePinnedSelectionRange(
  message: HTMLElement,
  pin: PinnedSelection | PinnedSelectionDraft,
): Range | null {
  const source = [
    ...message.querySelectorAll<HTMLElement>("[data-assistant-citation-source]"),
  ].find((element) => element.dataset.assistantCitationSource === pin.messageId);
  if (source) return resolveAssistantCitationRange(source, pin);
  return resolvePlainRange(
    message.querySelector<HTMLElement>("[data-thread-find-text]") ?? message,
    pin,
  );
}

export function selectionViewport(selection: Selection | null): HTMLElement | null {
  const anchor = selection?.anchorNode;
  const element = anchor instanceof Element ? anchor : anchor?.parentElement;
  return element?.closest<HTMLElement>("[data-pinned-selection-thread]") ?? null;
}
