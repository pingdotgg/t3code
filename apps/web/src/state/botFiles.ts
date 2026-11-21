import { createBotFilesEnvironmentAtoms } from "@t3tools/client-runtime/state/bot-files";

import { connectionAtomRuntime } from "../connection/runtime";

export const botFilesEnvironment = createBotFilesEnvironmentAtoms(connectionAtomRuntime);
