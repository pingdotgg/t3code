import type { CodeViewScrollTarget } from "@pierre/diffs";
import { useCallback, useEffect, useRef, useState } from "react";

interface FileRevealHandle {
  getInstance(): object | undefined;
  scrollTo(target: CodeViewScrollTarget): void;
}

// Wait for a mounted viewer and expanded rows, then apply each tree click once.
// Keep scope stable until the diff or external file selection changes.
export function useCodeViewFileReveal<TScope>(viewer: FileRevealHandle | null, scope: TScope) {
  const [request, setRequest] = useState<{ fileKey: string; scope: TScope } | null>(null);
  const handledRequest = useRef<typeof request>(null);

  useEffect(() => {
    if (request === null || handledRequest.current === request) return;
    if (request.scope !== scope) {
      handledRequest.current = request;
      return;
    }
    if (!viewer?.getInstance()) return;

    viewer.scrollTo({ type: "item", id: request.fileKey, align: "start" });
    handledRequest.current = request;
  }, [request, scope, viewer]);

  return useCallback((fileKey: string) => setRequest({ fileKey, scope }), [scope]);
}
