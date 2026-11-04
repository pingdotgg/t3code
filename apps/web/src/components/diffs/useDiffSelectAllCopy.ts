import type { CodeViewHandle } from "@pierre/diffs/react";
import { type Ref, useEffect, useState } from "react";

import { isEditableFocused } from "~/lib/editableFocus";
import { buildDiffFileText } from "~/reviewCommentContext";

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

class DiffSelectAll<LAnnotation> {
  handle: CodeViewHandle<LAnnotation, undefined> | null = null;
  // The file the last pointer interaction landed in.
  engagedItemId: string | null = null;
  // The file select all chose. The virtualizer drops its offscreen rows, so
  // copy writes the file's text instead of the drawn selection.
  selectedItemId: string | null = null;

  setHandle = (handle: CodeViewHandle<LAnnotation, undefined> | null) => {
    this.handle = handle;
  };

  itemText(itemId: string): string | null {
    const item = this.handle?.getItem(itemId);
    if (!item) return null;
    return item.type === "diff" ? buildDiffFileText(item.fileDiff) : item.file.contents;
  }

  drawSelection(itemId: string) {
    const element = this.handle
      ?.getInstance()
      ?.getRenderedItems()
      .find((item) => item.id === itemId)?.element;
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
      const itemId = this.selectedItemId;
      if (itemId === null || !event.clipboardData || isEditableFocused()) return;
      const text = this.itemText(itemId);
      if (text === null) return;
      event.clipboardData.setData("text/plain", text);
      event.preventDefault();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("copy", onCopy, true);
    return () => {
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
