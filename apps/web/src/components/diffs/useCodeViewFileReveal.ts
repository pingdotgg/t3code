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
  let pending: string | null = null;
  const flush = () => {
    if (pending === null || viewer === null) return;
    if (!viewer.getInstance() || viewer.getItem(pending) === undefined) return;
    viewer.scrollTo({ type: "item", id: pending, align: "start" });
    pending = null;
  };
  return {
    attach(next: FileRevealHandle | null) {
      if (viewer !== null && next !== viewer) pending = null;
      viewer = next;
      flush();
    },
    request(fileKey: string) {
      pending = fileKey;
      flush();
    },
    flush,
  };
}

export function useCodeViewFileReveal() {
  const [reveal] = useState(createCodeViewFileReveal);
  return reveal;
}
