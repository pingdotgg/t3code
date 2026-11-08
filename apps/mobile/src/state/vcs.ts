import { createScheduledTaskBaseRefAtomFamily } from "@t3tools/client-runtime/scheduled-task-base-ref";
import {
  createVcsActionManager,
  createVcsEnvironmentAtoms,
} from "@t3tools/client-runtime/state/vcs";

import { connectionAtomRuntime } from "../connection/runtime";

export const vcsEnvironment = createVcsEnvironmentAtoms(connectionAtomRuntime);
export const vcsActionManager = createVcsActionManager(connectionAtomRuntime);

export const scheduledTaskBaseRefAtom = createScheduledTaskBaseRefAtomFamily(
  vcsEnvironment.listRefs,
);
