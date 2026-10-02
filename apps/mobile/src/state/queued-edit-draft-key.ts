/**
 * The draft key a queued-message edit borrows.
 *
 * `<environmentId>:<threadId>~queued-edit~<runId>`: the marker holds no colon,
 * so `composerDraftEnvironmentId` still reads the environment from the segment
 * before the last colon and attachment uploads keep working, while the user's
 * own draft for the thread stays untouched under its own key.
 *
 * Lives apart from the edit session state so the draft store can recognize
 * these keys without importing it.
 */
const QUEUED_EDIT_DRAFT_MARKER = "~queued-edit~";

export function queuedEditDraftKey(threadKey: string, runId: string): string {
  return `${threadKey}${QUEUED_EDIT_DRAFT_MARKER}${runId}`;
}

export function isQueuedEditDraftKey(draftKey: string): boolean {
  return draftKey.includes(QUEUED_EDIT_DRAFT_MARKER);
}
