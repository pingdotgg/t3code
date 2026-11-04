import { createAgentSessionAtoms } from "@t3tools/client-runtime/state/agent-sessions";
import { connectionAtomRuntime } from "../connection/runtime";

export const agentSessions = createAgentSessionAtoms(connectionAtomRuntime);
export const agentSessionScan = agentSessions.scan;
export const agentSessionImport = agentSessions.importSession;
