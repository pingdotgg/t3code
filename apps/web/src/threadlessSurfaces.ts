import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  ProjectId,
  ThreadId,
  type EnvironmentId,
  type ScopedProjectRef,
  type ScopedThreadRef,
} from "@t3tools/contracts";

import { appAtomRegistry } from "./rpc/atomRegistry";
import { serverEnvironment } from "./state/server";

/** Use fixed project or environment refs for surfaces without threads. Their terminals, browsers and
 * devices persist through the same server and tab stores. */
const THREADLESS = "threadless";

export function threadlessSurfacesRef(
  environmentId: EnvironmentId,
  projectId: ProjectId | null,
): ScopedThreadRef {
  return scopeThreadRef(
    environmentId,
    ThreadId.make(projectId === null ? THREADLESS : `${THREADLESS}:${projectId}`),
  );
}

export function isThreadlessSurfacesRef(threadRef: ScopedThreadRef | null): boolean {
  return (
    threadRef !== null &&
    (threadRef.threadId === THREADLESS || threadRef.threadId.startsWith(`${THREADLESS}:`))
  );
}

/** The project a threadless ref's surfaces work in; null for any other ref. */
export function threadlessSurfacesProjectRef(
  threadRef: ScopedThreadRef | null,
): ScopedProjectRef | null {
  if (!threadRef?.threadId.startsWith(`${THREADLESS}:`)) return null;
  return scopeProjectRef(
    threadRef.environmentId,
    ProjectId.make(threadRef.threadId.slice(THREADLESS.length + 1)),
  );
}

/** A threadless ref without a project: its folder surfaces work in the server's home. */
export function isThreadlessHomeRef(
  threadRef: ScopedThreadRef | null,
): threadRef is ScopedThreadRef {
  return threadRef?.threadId === THREADLESS;
}

const homeConfigAtom = (threadRef: ScopedThreadRef | null) =>
  serverEnvironment.configValueAtom(
    isThreadlessHomeRef(threadRef) ? threadRef.environmentId : null,
  );

/**
 * The server's home folder for a threadless ref without a project; null for
 * any other ref, or a server too old to say.
 */
export function useThreadlessHome(threadRef: ScopedThreadRef | null): string | null {
  return useAtomValue(homeConfigAtom(threadRef))?.homeDirectory ?? null;
}

/** `useThreadlessHome`, read once outside React. */
export function readThreadlessHome(threadRef: ScopedThreadRef | null): string | null {
  if (!isThreadlessHomeRef(threadRef)) return null;
  return appAtomRegistry.get(homeConfigAtom(threadRef))?.homeDirectory ?? null;
}
