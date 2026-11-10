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
            getLinePosition(
              line: number,
              side?: SelectionSide,
            ): { top: number; height: number } | undefined;
          };
        }[];
      }
    | undefined;
  getItem(id: string): { collapsed?: boolean } | undefined;
  scrollTo(target: CodeViewScrollTarget): void;
}

/**
 * Scrolls a code view to a file. `attach` is the viewer's ref and `flush` its post-render
 * handler, so a reveal asked before the viewer mounts, or for a file it does not hold yet, is
 * positioned once it does. A reveal belongs to the diff it was asked of, so detaching the viewer,
 * such as remounting it for another diff scope, drops it.
 */
export function createCodeViewFileReveal() {
  let viewer: FileRevealHandle | null = null;
  let pending: { id: string; range?: SelectedLineRange; positionedFile?: boolean } | null = null;
  const flush = () => {
    if (pending === null || viewer === null) return;
    const item = viewer.getItem(pending.id);
    if (!viewer.getInstance() || item === undefined || item.collapsed === true) return;
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
      const startExpanded = rendered.instance.revealLine?.(additionLine(range.start, range.side));
      const endExpanded = rendered.instance.revealLine?.(
        additionLine(range.end, range.endSide ?? range.side),
      );
      if (startExpanded || endExpanded) return;
      if (
        !rendered.instance.getLinePosition(range.start, range.side) ||
        !rendered.instance.getLinePosition(range.end, range.endSide ?? range.side)
      )
        return;
    }
    const target = pending;
    pending = null;
    viewer.scrollTo(
      target.range
        ? { type: "range", id: target.id, range: target.range, align: "center" }
        : { type: "item", id: target.id, align: "start" },
    );
  };
  return {
    attach(next: FileRevealHandle | null) {
      if (viewer !== null && next !== viewer) pending = null;
      viewer = next;
      flush();
    },
    request(fileKey: string, range?: SelectedLineRange) {
      pending = { id: fileKey, ...(range ? { range } : {}) };
      flush();
    },
    flush,
  };
}

export function useCodeViewFileReveal() {
  const [reveal] = useState(createCodeViewFileReveal);
  return reveal;
}
