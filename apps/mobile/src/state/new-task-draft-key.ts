const NEW_TASK_DRAFT_PREFIX = "new-task:";

/** Every new-task draft key: `new-task:<draftId>`. */
export function newTaskDraftKey(draftId: string): string {
  return `${NEW_TASK_DRAFT_PREFIX}${draftId}`;
}

export function isNewTaskDraftKey(draftKey: string): boolean {
  return draftKey.startsWith(NEW_TASK_DRAFT_PREFIX);
}

/**
 * Builds before drafts were id-keyed used `new-task:<environmentId>:<projectId>`,
 * one slot per project. Ids are UUIDs and never contain a colon, so a colon
 * after the prefix marks the legacy shape. Returns the split scope, or null
 * when the key is not legacy.
 */
export function parseLegacyNewTaskDraftKey(
  draftKey: string,
): { readonly environmentId: string; readonly projectId: string } | null {
  if (!isNewTaskDraftKey(draftKey)) {
    return null;
  }
  const scope = draftKey.slice(NEW_TASK_DRAFT_PREFIX.length);
  const separator = scope.lastIndexOf(":");
  if (separator <= 0 || separator === scope.length - 1) {
    return null;
  }
  return { environmentId: scope.slice(0, separator), projectId: scope.slice(separator + 1) };
}
