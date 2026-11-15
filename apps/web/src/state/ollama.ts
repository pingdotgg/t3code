import { createOllamaEnvironmentAtoms } from "@t3tools/client-runtime/state/ollama";

import { connectionAtomRuntime } from "../connection/runtime";

export const ollamaEnvironment = createOllamaEnvironmentAtoms(connectionAtomRuntime);
