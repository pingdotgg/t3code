import { useAtomValue } from "@effect/atom-react";
import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import { resolveListedAncestorThreadRef } from "@t3tools/client-runtime/state/threads";

import { scopedThreadKey } from "../../lib/scopedEntities";
import { environmentThreadShells } from "../../state/threads";

/** An open subagent, side chat or delegated task has no row; its listed ancestor's row is selected. */
export function useSidebarRowThreadKey(openThreadKey: string | null): string | null {
  const threads = useAtomValue(environmentThreadShells.quietThreadShellsAtom);
  const openThreadRef = openThreadKey === null ? null : parseScopedThreadKey(openThreadKey);
  if (openThreadRef === null) return openThreadKey;
  const rowRef = resolveListedAncestorThreadRef(openThreadRef, threads);
  return scopedThreadKey(rowRef.environmentId, rowRef.threadId);
}
