/** Only explicit MCP names identify a server; ordinary tools are never guessed to be MCPs. */
export function summarizeMcpCalls(items: readonly { type: string; toolName?: string | null }[]) {
  const counts = new Map<string, number>();
  for (const item of items) {
    if (item.type !== "dynamic_tool" || !item.toolName) continue;
    const match = /^mcp__([^_].*?)__(.+)$/.exec(item.toolName);
    if (!match) continue;
    const server = match[1]!;
    counts.set(server, (counts.get(server) ?? 0) + 1);
  }
  return [...counts].map(([server, calls]) => ({ server, calls }));
}
