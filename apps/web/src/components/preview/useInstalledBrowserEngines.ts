import { useAtomValue } from "@effect/atom-react";
import type { PreviewBrowserEngine, ScopedThreadRef } from "@t3tools/contracts";
import { Atom, AsyncResult } from "effect/unstable/reactivity";

import { previewEnvironment } from "~/state/preview";

const NO_ENGINES: ReadonlyArray<PreviewBrowserEngine> = [];
const noThreadAtom = Atom.make(AsyncResult.initial<never, never>());

export function useInstalledBrowserEngines(
  threadRef: ScopedThreadRef | null | undefined,
): ReadonlyArray<PreviewBrowserEngine> {
  const atom = threadRef
    ? previewEnvironment.list({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId },
      })
    : noThreadAtom;
  const result = useAtomValue(atom);
  return AsyncResult.isSuccess(result) ? (result.value.engines ?? NO_ENGINES) : NO_ENGINES;
}
