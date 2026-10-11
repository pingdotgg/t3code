import {
  createPullRequestEnvironmentAtoms,
  createPullRequestStackAtomFamily,
} from "@t3tools/client-runtime/state/pull-requests";
import { connectionAtomRuntime } from "../connection/runtime";

export const composerPullRequests = createPullRequestEnvironmentAtoms(connectionAtomRuntime);
export const pullRequestStackAtom = createPullRequestStackAtomFamily(
  connectionAtomRuntime,
  composerPullRequests.refreshes,
);
