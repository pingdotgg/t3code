import { createAgentFileSyncAtoms } from "@t3tools/client-runtime/state/agentFileSync";
import { connectionAtomRuntime } from "../connection/runtime";
export const agentFileSync = createAgentFileSyncAtoms(connectionAtomRuntime);
