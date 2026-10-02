export function beginAcpMockPrompt(cancelledSessions: Set<string>, sessionId: string): void {
  cancelledSessions.delete(sessionId);
}
