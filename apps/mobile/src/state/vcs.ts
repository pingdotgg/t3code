import {
  createGitActionQueue,
  createVcsActionManager,
  createVcsEnvironmentAtoms,
} from "@t3tools/client-runtime/state/vcs";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "./atom-registry";
import { environmentThreadShells } from "./threads";

export const vcsEnvironment = createVcsEnvironmentAtoms(connectionAtomRuntime);
export const vcsActionManager = createVcsActionManager(connectionAtomRuntime);
export const gitActionQueue = createGitActionQueue({
  registry: appAtomRegistry,
  threadShellAtom: environmentThreadShells.threadShellAtom,
});
