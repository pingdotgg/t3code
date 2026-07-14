/**
 * MCP agent-toolkit threads have no parent/child marker on the wire. The
 * server-written title prefix is therefore the only durable roster signal.
 */
export function hasDelegatedAgentTitle(title: string): boolean {
  return title.startsWith("Agent: ");
}
