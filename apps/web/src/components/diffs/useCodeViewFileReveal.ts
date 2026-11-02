import type { CodeViewScrollTarget } from "@pierre/diffs";
import { useState } from "react";

interface FileRevealHandle {
  getInstance(): object | undefined;
  getItem(id: string): object | undefined;
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
  let pending: { fileKey: string; align: "start" | "nearest" } | null = null;
  const flush = () => {
    if (pending === null || viewer === null) return;
    if (!viewer.getInstance() || viewer.getItem(pending.fileKey) === undefined) return;
    viewer.scrollTo({ type: "item", id: pending.fileKey, align: pending.align });
    pending = null;
  };
  return {
    attach(next: FileRevealHandle | null) {
      if (viewer !== null && next !== viewer) pending = null;
      viewer = next;
      flush();
    },
    /** `nearest` leaves a file already on screen in place. */
    request(fileKey: string, align: "start" | "nearest" = "start") {
      pending = { fileKey, align };
      flush();
    },
    flush,
  };
}

export function useCodeViewFileReveal() {
  const [reveal] = useState(createCodeViewFileReveal);
  return reveal;
}
