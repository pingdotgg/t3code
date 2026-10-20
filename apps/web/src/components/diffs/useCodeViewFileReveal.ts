import type { CodeViewScrollTarget } from "@pierre/diffs";
import { useEffect, useRef, useState } from "react";

interface FileRevealHandle {
  getInstance(): object | undefined;
  scrollTo(target: CodeViewScrollTarget): void;
}

export function useCodeViewFileReveal<TScope>(
  viewer: FileRevealHandle | null,
  scope: TScope,
  readyFileKeys?: ReadonlyArray<string>,
) {
  const [request, setRequest] = useState<{
    fileKey: string;
    scope: TScope;
    target?: CodeViewScrollTarget;
  } | null>(null);
  const handledRequest = useRef<typeof request>(null);

  useEffect(() => {
    if (request === null || handledRequest.current === request) return;
    if (request.scope !== scope) {
      handledRequest.current = request;
      return;
    }
    if (!viewer?.getInstance() || (readyFileKeys && !readyFileKeys.includes(request.fileKey)))
      return;

    viewer.scrollTo(request.target ?? { type: "item", id: request.fileKey, align: "start" });
    handledRequest.current = request;
  }, [request, scope, viewer, readyFileKeys]);

  return (fileKey: string, target?: CodeViewScrollTarget) =>
    setRequest({ fileKey, scope, ...(target ? { target } : {}) });
}
