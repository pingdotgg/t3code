import {
  createOrchestrationEnvironmentAtoms,
  createTaskEnvironmentCommands,
} from "@t3tools/client-runtime/state/orchestration";

import { connectionAtomRuntime } from "../connection/runtime";

export const orchestrationEnvironment = createOrchestrationEnvironmentAtoms(connectionAtomRuntime);
export const taskCommands: ReturnType<typeof createTaskEnvironmentCommands> =
  createTaskEnvironmentCommands(connectionAtomRuntime);
