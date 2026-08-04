import {
  createVcsActionManager,
  createVcsEnvironmentAtoms,
} from "@t3tools/client-runtime/state/vcs";

import { connectionAtomRuntime } from "../connection/runtime";

export const vcsEnvironment = createVcsEnvironmentAtoms(connectionAtomRuntime);
export const threadVcsEnvironment = createVcsEnvironmentAtoms(connectionAtomRuntime, {
  // Sidebar v2 time-slices hidden PR lookups. Dispose each status stream as
  // soon as its last row/reporter unmounts so the pool also bounds server pollers.
  statusIdleTtlMs: 0,
});
export const vcsActionManager = createVcsActionManager(connectionAtomRuntime);
