export interface TimelineDurationMessage {
  id: string;
  role: "user" | "assistant" | "system";
  createdAt: string;
  completedAt?: string | undefined;
}

export function computeMessageDurationStart(
  messages: ReadonlyArray<TimelineDurationMessage>,
): Map<string, string> {
  const result = new Map<string, string>();
  let lastBoundary: string | null = null;

  for (const message of messages) {
    if (message.role === "user") {
      lastBoundary = message.createdAt;
    }
    result.set(message.id, lastBoundary ?? message.createdAt);
    if (message.role === "assistant" && message.completedAt) {
      lastBoundary = message.completedAt;
    }
  }

  return result;
}

export function normalizeCompactToolLabel(value: string): string {
  let label = value.replace(/\s+(?:complete|completed)\s*$/i, "").trim();

  // Humanize MCP tool names: "Mcp__server-name__tool_name" → "Tool name"
  const mcpMatch = label.match(/^Mcp__[^_]+__(.+)$/i);
  if (mcpMatch) {
    label = mcpMatch[1]!.replace(/_/g, " ");
  }

  return label;
}
