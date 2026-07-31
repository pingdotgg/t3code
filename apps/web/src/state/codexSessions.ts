import { createCodexSessionEnvironmentAtoms } from "@t3tools/client-runtime/state/codex-sessions";

import { connectionAtomRuntime } from "../connection/runtime";

export const codexSessionEnvironment = createCodexSessionEnvironmentAtoms(connectionAtomRuntime);
