/**
 * `<environmentId>:<threadId>~queued-edit~<runId>`: the marker holds no colon,
 * so `composerDraftEnvironmentId` still reads the environment from the segment
 * before the last colon and attachment uploads keep working, while the user's
 * own draft for the thread stays untouched under its own key.
 */
const QUEUED_EDIT_DRAFT_MARKER = "~queued-edit~";

export function queuedEditDraftKey(threadKey: string, runId: string): string {
  return `${threadKey}${QUEUED_EDIT_DRAFT_MARKER}${runId}`;
}

export function isQueuedEditDraftKey(draftKey: string): boolean {
  return draftKey.includes(QUEUED_EDIT_DRAFT_MARKER);
}
