const operationsByDraftKey = new Map<string, Map<AbortController, Promise<void>>>();

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
  const operations =
    operationsByDraftKey.get(draftKey) ?? new Map<AbortController, Promise<void>>();
  let complete!: () => void;
  const completed = new Promise<void>((resolve) => {
    complete = resolve;
  });
  controller.signal.addEventListener("abort", complete, { once: true });
  operations.set(controller, completed);
  operationsByDraftKey.set(draftKey, operations);
  return {
    signal: controller.signal,
    finish: () => {
      complete();
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
  for (const controller of operations.keys()) controller.abort();
}

export function abortComposerDraftOperationsWhere(matches: (draftKey: string) => boolean): void {
  // Deleting the current entry while iterating a Map is safe.
  for (const draftKey of operationsByDraftKey.keys()) {
    if (matches(draftKey)) abortComposerDraftOperations(draftKey);
  }
}

export async function waitForComposerDraftOperations(draftKey: string): Promise<void> {
  while (operationsByDraftKey.has(draftKey)) {
    await Promise.all(operationsByDraftKey.get(draftKey)!.values());
  }
}
