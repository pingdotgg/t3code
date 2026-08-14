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

  // A value emitted by native paired with a different selection is an
  // intermediate React render. Keep it behind the native revision so it
  // cannot move the caret while newer keystrokes are being processed.
  if (newestValueEventCount !== null && mostRecentEventCount > 0) {
    return Math.min(newestValueEventCount, mostRecentEventCount - 1);
  }

  return mostRecentEventCount;
}

// A snapshot without a selection describes a state the editor applied itself
// (an assumed controlled document, where the native side may have bounded the
// caret). Revision stamping treats it as matching any controlled selection so
// a parent caret move on the assumed value stays at the assumed revision and
// passes the editor's staleness guard. Echo detection must not reuse this
// wildcard: an echo payload serializes `selection: null`, which would drop
// that caret move instead of applying it.
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

/**
 * Records that a parent-driven controlled document was handed to the native
 * editor. From that point the acknowledged snapshot history describes a
 * superseded native state, so it is replaced with the assumed applied state;
 * a later parent update back to a previously acknowledged value must classify
 * as a fresh edit, not as a native echo the editor would drop. Native events
 * that raced past the controlled revision stay authoritative and are kept.
 */
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
  // The newest acknowledged snapshot must survive pruning: it is what lets a
  // later, unrelated re-render classify the settled composer state as a native
  // echo instead of a parent-driven edit that would re-control the caret (and
  // reset the keyboard's autocorrect context on iOS).
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
