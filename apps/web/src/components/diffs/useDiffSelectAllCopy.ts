import type { CodeViewHandle } from "@pierre/diffs/react";
import { type Ref, useEffect, useState } from "react";

import { isEditableFocused } from "~/lib/editableFocus";
import { buildDiffFileText, buildDiffRangeText, type DiffTextPoint } from "~/reviewCommentContext";

function matchesShortcutKey(event: KeyboardEvent, key: string, code: string): boolean {
  const pressedKey = event.key.toLowerCase();
  return /^[a-z]$/.test(pressedKey) ? pressedKey === key : event.code === code;
}

function isSelectAll(event: KeyboardEvent): boolean {
  return (
    matchesShortcutKey(event, "a", "KeyA") &&
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    !event.shiftKey
  );
}

function isCopy(event: KeyboardEvent): boolean {
  return matchesShortcutKey(event, "c", "KeyC") && (event.metaKey || event.ctrlKey);
}

const MODIFIER_KEYS = new Set(["Meta", "Control", "Shift", "Alt"]);

function rowPoint(node: Node, offset: number): DiffTextPoint | null {
  const element = node instanceof Element ? node : node.parentElement;
  const row = element?.closest("[data-line]");
  if (!row) return null;
  const prefix = document.createRange();
  prefix.setStart(row, 0);
  prefix.setEnd(node, offset);
  const deletions =
    row.getAttribute("data-line-type") === "change-deletion" || !!row.closest("[data-deletions]");
  return {
    side: deletions ? "old" : "new",
    line: Number(row.getAttribute("data-line")),
    offset: prefix.toString().length,
  };
}

function selectedRange(root: ShadowRoot): AbstractRange | null {
  const selection = document.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  if (typeof selection.getComposedRanges !== "function") return selection.getRangeAt(0);
  try {
    return selection.getComposedRanges({ shadowRoots: [root] })[0] ?? null;
  } catch {
    // Safari 17 takes the shadow roots as arguments.
    const legacy = selection.getComposedRanges as unknown as (root: ShadowRoot) => StaticRange[];
    return legacy.call(selection, root)[0] ?? null;
  }
}

function elementOf(node: Node): Element | null {
  return node instanceof Element ? node : node.parentElement;
}

interface RowSelection {
  readonly start: DiffTextPoint;
  readonly end: DiffTextPoint;
  readonly split: boolean;
}

// The selection's ends in this file's rows. An end is null when the virtualizer
// removed its row; it fires no selectionchange for that, so copy reads it again.
function readSelection(
  root: ShadowRoot,
): { start: DiffTextPoint | null; end: DiffTextPoint | null; split: boolean | null } | null {
  const range = selectedRange(root);
  if (!range) return null;
  const { startContainer, endContainer } = range;
  const start = rowPoint(startContainer, range.startOffset);
  const end = rowPoint(endContainer, range.endOffset);
  if (start && end && range.collapsed) return null;
  // The virtualizer only removes rows, so an end it moved stays in the file's code.
  const kept = (node: Node, point: DiffTextPoint | null) =>
    point !== null || (root.contains(node) && !!elementOf(node)?.closest("pre"));
  if (!kept(startContainer, start) || !kept(endContainer, end)) return null;
  const inRow = start ? startContainer : end ? endContainer : null;
  const split = inRow && !!elementOf(inRow)?.closest("[data-additions], [data-deletions]");
  return { start, end, split };
}

class DiffSelectAll<LAnnotation> {
  handle: CodeViewHandle<LAnnotation, undefined> | null = null;
  // The file the last pointer interaction landed in.
  engagedItemId: string | null = null;
  // The file select all chose. The virtualizer drops its offscreen rows, so
  // copy writes the file's text instead of the drawn selection.
  selectedItemId: string | null = null;
  // A selection made in the engaged file, kept while the virtualizer drops its rows.
  dragged: (RowSelection & { readonly itemId: string }) | null = null;

  setHandle = (handle: CodeViewHandle<LAnnotation, undefined> | null) => {
    this.handle = handle;
  };

  itemText(itemId: string): string | null {
    const item = this.handle?.getItem(itemId);
    if (!item) return null;
    return item.type === "diff" ? buildDiffFileText(item.fileDiff) : item.file.contents;
  }

  renderedElement(itemId: string): HTMLElement | undefined {
    return this.handle
      ?.getInstance()
      ?.getRenderedItems()
      .find((item) => item.id === itemId)?.element;
  }

  draggedText(): string | null {
    const dragged = this.dragged;
    if (!dragged) return null;
    const root = this.renderedElement(dragged.itemId)?.shadowRoot;
    const live = root && readSelection(root);
    // While both ends are mounted the browser copies the selection itself.
    if (root && (!live || (live.start && live.end))) return null;
    const item = this.handle?.getItem(dragged.itemId);
    if (item?.type !== "diff") return null;
    const { start, end, split } = dragged;
    // A split selection spanning both columns copies as the browser lays it out.
    if (split && start.side !== end.side) return null;
    return buildDiffRangeText(item.fileDiff, start, end, split ? start.side : null);
  }

  trackSelection() {
    const itemId = this.engagedItemId;
    if (this.dragged?.itemId !== itemId) this.dragged = null;
    const root = itemId === null ? null : this.renderedElement(itemId)?.shadowRoot;
    if (itemId === null || !root) return;
    const live = readSelection(root);
    // An end whose row unmounted keeps its recorded point; the other follows the drag.
    const start = live && (live.start ?? this.dragged?.start);
    const end = live && (live.end ?? this.dragged?.end);
    const split = live?.split ?? this.dragged?.split;
    this.dragged = start && end && split != null ? { itemId, start, end, split } : null;
  }

  drawSelection(itemId: string) {
    const element = this.renderedElement(itemId);
    const rows = element?.shadowRoot?.querySelectorAll("[data-line]");
    const first = rows?.[0];
    const last = rows?.[rows.length - 1];
    if (!first || !last) return;
    document.getSelection()?.setBaseAndExtent(first, 0, last, last.childNodes.length);
  }

  listen(): () => void {
    const onPointerDown = (event: PointerEvent) => {
      this.selectedItemId = null;
      const path = event.composedPath();
      this.engagedItemId =
        this.handle
          ?.getInstance()
          ?.getRenderedItems()
          .find((item) => path.includes(item.element))?.id ?? null;
    };
    const onSelectionChange = () => this.trackSelection();
    const onKeyDown = (event: KeyboardEvent) => {
      if (MODIFIER_KEYS.has(event.key) || isCopy(event)) return;
      this.selectedItemId = null;
      const itemId = this.engagedItemId;
      if (!isSelectAll(event) || itemId === null || isEditableFocused(event.target)) return;
      if (this.itemText(itemId) === null) return;
      event.preventDefault();
      this.selectedItemId = itemId;
      this.drawSelection(itemId);
    };
    const onCopy = (event: ClipboardEvent) => {
      if (!event.clipboardData || isEditableFocused()) return;
      const itemId = this.selectedItemId;
      const text = itemId === null ? this.draggedText() : this.itemText(itemId);
      if (text === null) return;
      event.clipboardData.setData("text/plain", text);
      event.preventDefault();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("copy", onCopy, true);
    document.addEventListener("selectionchange", onSelectionChange);
    return () => {
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("copy", onCopy, true);
    };
  }
}

/**
 * Scopes select all to the diff file the user is working in and copies all of
 * its lines, since the virtualizer only keeps the rows near the viewport.
 */
export function useDiffSelectAllCopy<LAnnotation>() {
  const [selectAll] = useState(() => new DiffSelectAll<LAnnotation>());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- document listeners live while the viewer is mounted
  useEffect(() => selectAll.listen(), [selectAll]);
  return selectAll.setHandle;
}

export function setRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (typeof ref === "function") ref(value);
  else if (ref) ref.current = value;
}
