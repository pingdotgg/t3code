import {
  createVcsActionManager,
  createVcsEnvironmentAtoms,
} from "@t3tools/client-runtime/state/vcs";

import { connectionAtomRuntime } from "../connection/runtime";

export const vcsEnvironment = createVcsEnvironmentAtoms(connectionAtomRuntime);
export const threadVcsEnvironment = createVcsEnvironmentAtoms(connectionAtomRuntime, {
  // Thread List v2 time-slices off-screen PR lookups. Dispose each status
  // stream as soon as its last row/reporter unmounts so the pool's cap also
  // bounds server pollers without changing caching for other mobile Git UI.
  statusIdleTtlMs: 0,
});
export const vcsActionManager = createVcsActionManager(connectionAtomRuntime);
