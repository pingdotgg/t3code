import { createGitHubIssueEnvironmentAtoms } from "@t3tools/client-runtime/state/github-issues";

import { connectionAtomRuntime } from "../connection/runtime";

export const githubIssueEnvironment = createGitHubIssueEnvironmentAtoms(connectionAtomRuntime);
