import {
  createVcsActionManager,
  createVcsEnvironmentAtoms,
  createVcsStatusRevalidationAtomFamily,
} from "@t3tools/client-runtime/state/vcs";
import * as Equal from "effect/Equal";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { subscribeDocumentReturn } from "../lib/documentActivity";

export const vcsEnvironment = createVcsEnvironmentAtoms(connectionAtomRuntime);
export const vcsActionManager = createVcsActionManager(connectionAtomRuntime);

/** Only what a chat view reads, so changing file counts don't re-render it on every edit. */
export const chatGitStatusAtom = Atom.family((status: ReturnType<typeof vcsEnvironment.status>) =>
  Atom.map(status, (result) => {
    const data = AsyncResult.getOrElse(result, () => null);
    if (data === null) return null;
    const { isRepo, refName, hasWorkingTreeChanges, pr } = data;
    return { isRepo, refName, hasWorkingTreeChanges, pr };
  }).pipe(Atom.withEquality(Equal.equals)),
);
export const NO_CHAT_GIT_STATUS_ATOM: ReturnType<typeof chatGitStatusAtom> = Atom.make(null);

/**
 * Refreshes a checkout's status when the user comes back to the window, where
 * edits made in another app or terminal may be waiting.
 */
export const vcsStatusRevalidation = createVcsStatusRevalidationAtomFamily({
  refreshStatus: vcsEnvironment.refreshStatus,
  subscribeWake: subscribeDocumentReturn,
  wakeDebounceMs: 250,
});
