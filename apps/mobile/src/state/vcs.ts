import {
  createVcsActionManager,
  createVcsEnvironmentAtoms,
} from "@t3tools/client-runtime/state/vcs";
import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

export const vcsEnvironment = createVcsEnvironmentAtoms(connectionAtomRuntime);
export const vcsActionManager = createVcsActionManager(connectionAtomRuntime);

// Action confirmations need a finite request; listRefs stays subscribed for cache updates.
export const vcsRefsQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "mobile:vcs:refs-query",
  tag: WS_METHODS.vcsListRefs,
});
