import type {
  CodeViewScrollTarget,
  SelectedLineRange,
  FileDiffMetadata,
  SelectionSide,
} from "@pierre/diffs";
import { useState } from "react";

interface FileRevealHandle {
  getInstance():
    | {
        getRenderedItems?(): readonly {
          id: string;
          instance: {
            getDiffForSearch?(): FileDiffMetadata | undefined;
            revealLine?(line: number): boolean;
            expandHunk?(hunkIndex: number, direction: "up" | "down", lineCount: number): void;
            getLinePosition(
              line: number,
              side?: SelectionSide,
            ): { top: number; height: number } | undefined;
          };
        }[];
        getHeight?(): number;
        getScrollHeight?(): number;
      }
    | undefined;
  getItem(id: string): { collapsed?: boolean; fileDiff?: { cacheKey?: string } } | undefined;
  scrollTo(target: CodeViewScrollTarget): void;
}

// Mirrors the viewer's `revealLine`, which reads distances from the edges of the collapsed gap.
function expandPartialDiffToLine(
  diff: FileDiffMetadata,
  line: number,
  expandHunk: (hunkIndex: number, direction: "up" | "down", lineCount: number) => void,
): boolean {
  const { hunks } = diff;
  if (
    hunks.some(
      (hunk) => line >= hunk.additionStart && line < hunk.additionStart + hunk.additionCount,
    )
  ) {
    return false;
  }
  const next = hunks.findIndex((hunk) => line < hunk.additionStart);
  const previous = next === -1 ? hunks.at(-1) : hunks[next - 1];
  const fromStart = line - (previous ? previous.additionStart + previous.additionCount : 1) + 1;
  const after = next === -1 ? undefined : hunks[next];
  if (after === undefined) expandHunk(hunks.length, "up", fromStart + REVEAL_CONTEXT_LINES);
  else if (fromStart <= after.additionStart - line) {
    expandHunk(next, "up", fromStart + REVEAL_CONTEXT_LINES);
  } else expandHunk(next, "down", after.additionStart - line + REVEAL_CONTEXT_LINES);
  return true;
}

const REVEAL_CONTEXT_LINES = 10;

/**
 * Scrolls a code view to a file. `attach` is the viewer's ref and `flush` its post-render
 * handler, so a reveal asked before the viewer mounts, or for a file it does not hold yet, is
 * positioned once it does. A reveal belongs to the diff it was asked of, so a viewer remounted for
 * another diff scope, which no longer holds the file, drops it.
 */
export function createCodeViewFileReveal(restore?: { id: string; offset: number }) {
  let viewer: FileRevealHandle | null = null;
  let detachedInstance: object | undefined;
  let pending: {
    id: string;
    range?: SelectedLineRange;
    /** A saved scroll position: `offset` from the file's top, applied once the file has loaded. */
    offset?: number;
    positionedFile?: boolean;
    loadingFile?: boolean;
    settling?: boolean;
  } | null = restore ? { ...restore } : null;
  const flush = () => {
    if (pending === null || viewer === null) return;
    const item = viewer.getItem(pending.id);
    if (!viewer.getInstance() || item === undefined || item.collapsed === true) return;
    if (pending.offset !== undefined) {
      const instance = viewer.getInstance();
      // An offset only means the same place once the viewport is laid out and the file's patch,
      // not its placeholder, is rendered.
      if (
        !instance?.getHeight?.() ||
        !instance.getScrollHeight?.() ||
        item.fileDiff?.cacheKey?.endsWith(":pending")
      )
        return;
    }
    const renderedItems = viewer.getInstance()?.getRenderedItems?.();
    if (pending.range && renderedItems) {
      const rendered = renderedItems.find((entry) => entry.id === pending?.id);
      if (!rendered) {
        if (!pending.positionedFile) {
          pending.positionedFile = true;
          viewer.scrollTo({ type: "item", id: pending.id, align: "start" });
        }
        return;
      }
      const diff = rendered.instance.getDiffForSearch?.();
      const additionLine = (line: number, side: SelectionSide | undefined) => {
        if (side !== "deletions" || !diff) return line;
        const next = diff.hunks.find((hunk) => line < hunk.deletionStart + hunk.deletionCount);
        const last = diff.hunks.at(-1);
        return next
          ? line + next.additionStart - next.deletionStart
          : last
            ? line +
              last.additionStart +
              last.additionCount -
              last.deletionStart -
              last.deletionCount
            : line;
      };
      const { range } = pending;
      const startLine = additionLine(range.start, range.side);
      const endLine = additionLine(range.end, range.endSide ?? range.side);
      // A patch-only diff holds no unchanged lines, and `revealLine` declines to expand it. The
      // viewer's own expander loads the file first, so a line outside every hunk is opened with it.
      if (diff?.isPartial && rendered.instance.expandHunk) {
        // Wait for the file contents the expander asked for.
        if (pending.loadingFile) return;
        const { expandHunk } = rendered.instance;
        // A removed line is always in a hunk, and a deleted file has no contents to load.
        const removed = (line: number, side: SelectionSide | undefined) =>
          side === "deletions" &&
          diff.hunks.some(
            (hunk) => line >= hunk.deletionStart && line < hunk.deletionStart + hunk.deletionCount,
          );
        const outside = [
          ...new Set([
            ...(removed(range.start, range.side) ? [] : [startLine]),
            ...(removed(range.end, range.endSide ?? range.side) ? [] : [endLine]),
          ]),
        ];
        const opened = outside.map((line) => expandPartialDiffToLine(diff, line, expandHunk));
        if (opened.some(Boolean)) {
          pending.loadingFile = true;
          return;
        }
      }
      const startExpanded = rendered.instance.revealLine?.(startLine);
      const endExpanded = rendered.instance.revealLine?.(endLine);
      if (startExpanded || endExpanded) return;
      if (
        !rendered.instance.getLinePosition(range.start, range.side) ||
        !rendered.instance.getLinePosition(range.end, range.endSide ?? range.side)
      )
        return;
    }
    const target = pending;
    // The diff's first load can remount the viewer or re-render it right after this scroll, which
    // loses it; a range or saved offset is positioned once more on the next render that can hold it.
    pending =
      (target.range || target.offset !== undefined) && !target.settling
        ? { ...target, settling: true }
        : null;
    viewer.scrollTo(
      target.range
        ? { type: "range", id: target.id, range: target.range, align: "center" }
        : {
            type: "item",
            id: target.id,
            align: "start",
            ...(target.offset === undefined ? {} : { offset: target.offset }),
          },
    );
  };
  return {
    attach(next: FileRevealHandle | null) {
      // The viewer rebuilds its handle on every render and can remount during the diff's first
      // load. Item ids carry the diff's scope, so only a viewer without the item drops the reveal.
      const previous = viewer?.getInstance() ?? detachedInstance;
      if (next === null) detachedInstance = previous;
      else {
        const instance = next.getInstance();
        if (pending !== null && previous !== undefined && instance !== previous) {
          // A saved offset belongs to its scope, not to a viewer, so it waits for the file to load.
          if (
            pending.offset === undefined &&
            (instance === undefined || next.getItem(pending.id) === undefined)
          )
            pending = null;
          // A new instance starts from the patch again, so it must expand the line itself.
          else pending.loadingFile = false;
        }
        detachedInstance = undefined;
      }
      viewer = next;
      flush();
    },
    request(fileKey: string, range?: SelectedLineRange) {
      pending = { id: fileKey, ...(range ? { range } : {}) };
      flush();
    },
    /** The user scrolled; a reveal still being positioned must not pull them back. */
    cancel() {
      pending = null;
    },
    flush,
  };
}

/** A new `scopeKey` starts a new reveal, restoring `restore` if given. */
export function useCodeViewFileReveal(
  scopeKey?: string,
  restore?: { id: string; offset: number },
) {
  const [state, setState] = useState(() => ({
    scopeKey,
    reveal: createCodeViewFileReveal(restore),
  }));
  if (state.scopeKey !== scopeKey) {
    const next = { scopeKey, reveal: createCodeViewFileReveal(restore) };
    setState(next);
    return next.reveal;
  }
  return state.reveal;
}
