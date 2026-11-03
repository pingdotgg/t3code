export interface ComposerNativeEventSnapshot {
  readonly eventCount: number;
  readonly value: string;
  readonly selection: ComposerEditorSelection | null;
}

interface ComposerEditorSelection {
  readonly start: number;
  readonly end: number;
}

export function acknowledgeComposerNativeEvent(
  mostRecentEventCount: number,
  incomingEventCount: number,
): number | null {
  if (!Number.isSafeInteger(incomingEventCount) || incomingEventCount < mostRecentEventCount) {
    return null;
  }
  return incomingEventCount;
}

export function resolveComposerControlledEventCount(
  value: string,
  selection: ComposerEditorSelection | null,
  mostRecentEventCount: number,
  snapshots: ReadonlyArray<ComposerNativeEventSnapshot>,
): number {
  let newestValueEventCount: number | null = null;
  for (let index = snapshots.length - 1; index >= 0; index -= 1) {
    const snapshot = snapshots[index];
    if (snapshot?.value !== value) continue;

    newestValueEventCount ??= snapshot.eventCount;
    if (selection === null || snapshotSelectionMatches(snapshot, selection)) {
      return snapshot.eventCount;
    }
  }

  // Mismatched native text/selection pairs are intermediate renders; keep their revision behind to avoid moving the caret.
  if (newestValueEventCount !== null && mostRecentEventCount > 0) {
    return Math.min(newestValueEventCount, mostRecentEventCount - 1);
  }

  return mostRecentEventCount;
}

// Null-selection snapshots allow assumed bounded carets; echoes must not use that wildcard or drop caret moves.
function snapshotSelectionMatches(
  snapshot: ComposerNativeEventSnapshot,
  selection: ComposerEditorSelection,
): boolean {
  if (snapshot.selection === null) return true;
  return snapshot.selection.start === selection.start && snapshot.selection.end === selection.end;
}

export function isComposerNativeEcho(
  value: string,
  selection: ComposerEditorSelection | null,
  eventCount: number,
  snapshots: ReadonlyArray<ComposerNativeEventSnapshot>,
): boolean {
  for (let index = snapshots.length - 1; index >= 0; index -= 1) {
    const snapshot = snapshots[index];
    if (
      snapshot !== undefined &&
      snapshot.eventCount === eventCount &&
      snapshot.value === value &&
      (selection === null ||
        (snapshot.selection !== null &&
          snapshot.selection.start === selection.start &&
          snapshot.selection.end === selection.end))
    ) {
      return true;
    }
  }
  return false;
}

/** Replace history with assumed controlled state so returning to old native values counts as fresh parent edits. */
export function assumeComposerControlledState(
  snapshots: ReadonlyArray<ComposerNativeEventSnapshot>,
  eventCount: number,
  value: string,
): ComposerNativeEventSnapshot[] {
  return [
    { eventCount, value, selection: null },
    ...snapshots.filter((snapshot) => snapshot.eventCount > eventCount),
  ];
}

export function pruneAcknowledgedComposerNativeEvents(
  snapshots: ReadonlyArray<ComposerNativeEventSnapshot>,
  acknowledgedEventCount: number,
): ComposerNativeEventSnapshot[] {
  // Retain the latest acknowledgement so unrelated renders stay echoes and do not reset caret or iOS autocorrect.
  let latestAcknowledgedIndex = -1;
  for (let index = snapshots.length - 1; index >= 0; index -= 1) {
    const snapshot = snapshots[index];
    if (snapshot !== undefined && snapshot.eventCount <= acknowledgedEventCount) {
      latestAcknowledgedIndex = index;
      break;
    }
  }
  return snapshots.filter(
    (snapshot, index) =>
      index === latestAcknowledgedIndex || snapshot.eventCount > acknowledgedEventCount,
  );
}
