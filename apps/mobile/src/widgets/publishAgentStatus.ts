import type { AgentStatusSnapshot } from "./agentStatusSnapshot";

// The Agent status widget is iOS-only; Android shows agent work in its ongoing notification.
export function publishAgentStatus(_snapshot: AgentStatusSnapshot) {}
