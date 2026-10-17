import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { useState } from "react";

function toThreadRef(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
): ScopedThreadRef | null {
  return environmentId !== null && threadId !== null
    ? scopeThreadRef(environmentId, threadId)
    : null;
}

/**
 * Takes the thread object but keys on its ids: the shell changes identity on every update
 * during a run, and effects keyed on this ref must not re-run for that.
 */
export function useActiveThreadRef(
  thread: { readonly environmentId: EnvironmentId; readonly id: ThreadId } | null | undefined,
): ScopedThreadRef | null {
  const environmentId = thread?.environmentId ?? null;
  const threadId = thread?.id ?? null;
  const [ref, setRef] = useState(() => toThreadRef(environmentId, threadId));
  if ((ref?.environmentId ?? null) !== environmentId || (ref?.threadId ?? null) !== threadId) {
    const next = toThreadRef(environmentId, threadId);
    setRef(next);
    return next;
  }
  return ref;
}
