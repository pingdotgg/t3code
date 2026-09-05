export function isReconnectMcpCommand(text: string): boolean {
  return /^\/reconnect-mcp\s*$/i.test(text.trim());
}
