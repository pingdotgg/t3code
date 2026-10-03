import { createWorktreeEnvironmentAtoms } from "@t3tools/client-runtime/state/worktrees";

import { connectionAtomRuntime } from "../connection/runtime";

export const worktreeEnvironment = createWorktreeEnvironmentAtoms(connectionAtomRuntime);
