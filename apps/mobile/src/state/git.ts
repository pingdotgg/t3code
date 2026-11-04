import { createGitEnvironmentAtoms } from "@t3tools/client-runtime/state/git";
import { connectionAtomRuntime } from "../connection/runtime";
import { vcsActionManager } from "./vcs";

export const gitEnvironment = createGitEnvironmentAtoms(
  connectionAtomRuntime,
  vcsActionManager.track,
);
