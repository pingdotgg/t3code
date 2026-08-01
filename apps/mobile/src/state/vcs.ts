import {
  createVcsActionManager,
  createVcsEnvironmentAtoms,
} from "@t3tools/client-runtime/state/vcs";

import { connectionAtomRuntime } from "../connection/runtime";

export const vcsEnvironment = createVcsEnvironmentAtoms(connectionAtomRuntime, {
  // Thread List v2 time-slices off-screen PR lookups. Dispose each status
  // stream as soon as its last row/reporter unmounts so the pool's cap also
  // bounds server pollers; web keeps the default warm-cache TTL.
  statusIdleTtlMs: 0,
});
export const vcsActionManager = createVcsActionManager(connectionAtomRuntime);
