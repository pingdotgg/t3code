/**
 * Codex supports multiple provider threads in one app-server session, so native
 * fork recording keeps the request ids emitted by that single client.
 */
export function codexReplayRecordingOutputRecords(
  records: ReadonlyArray<Record<string, unknown>>,
): ReadonlyArray<Record<string, unknown>> {
  return [...records];
}
