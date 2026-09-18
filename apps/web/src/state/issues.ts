import { createIssueEnvironmentAtoms } from "@t3tools/client-runtime/state/issues";

import { connectionAtomRuntime } from "../connection/runtime";

export const issueEnvironment = createIssueEnvironmentAtoms(connectionAtomRuntime);
