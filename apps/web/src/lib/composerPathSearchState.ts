import {
  type ComposerPathSearchState,
  type ComposerPathSearchTarget,
} from "@t3tools/client-runtime/state/threads";

import { useMemo } from "react";

import { useComposerPathSearch as useComposerPathSearchQuery } from "../state/queries";

export function useComposerPathSearch(target: ComposerPathSearchTarget): ComposerPathSearchState {
  const state = useComposerPathSearchQuery(target);
  // A stable list lets the composer menu memo cache between renders.
  const entries = useMemo(
    () => state.entries.map((entry) => ({ path: entry.path, kind: entry.kind })),
    [state.entries],
  );
  return {
    entries,
    error: state.error,
    isPending: state.isPending,
  };
}
