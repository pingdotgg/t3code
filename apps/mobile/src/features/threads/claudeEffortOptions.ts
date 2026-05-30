export const CLAUDE_AGENT_EFFORT_OPTIONS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultrathink",
] as const;

export type ClaudeAgentEffort = (typeof CLAUDE_AGENT_EFFORT_OPTIONS)[number];
