const operationsByDraftKey = new Map<string, Set<AbortController>>();

/**
 * Async work that writes into one draft (a context import, a picker) starts
 * here. Whoever discards that draft or moves the composer off it aborts the
 * work, so a late result never lands in a draft the user has left.
 */
export function startComposerDraftOperation(draftKey: string): {
  readonly signal: AbortSignal;
  readonly finish: () => void;
} {
  const controller = new AbortController();
  const operations = operationsByDraftKey.get(draftKey) ?? new Set();
  operations.add(controller);
  operationsByDraftKey.set(draftKey, operations);
  return {
    signal: controller.signal,
    finish: () => {
      operations.delete(controller);
      if (operations.size === 0 && operationsByDraftKey.get(draftKey) === operations) {
        operationsByDraftKey.delete(draftKey);
      }
    },
  };
}

export function abortComposerDraftOperations(draftKey: string): void {
  const operations = operationsByDraftKey.get(draftKey);
  if (!operations) return;
  operationsByDraftKey.delete(draftKey);
  for (const controller of operations) controller.abort();
}

export function abortComposerDraftOperationsWhere(matches: (draftKey: string) => boolean): void {
  // Deleting the current entry while iterating a Map is safe.
  for (const draftKey of operationsByDraftKey.keys()) {
    if (matches(draftKey)) abortComposerDraftOperations(draftKey);
  }
}
