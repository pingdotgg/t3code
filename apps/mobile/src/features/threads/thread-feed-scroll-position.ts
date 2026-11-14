export interface ThreadWorkGroupScrollPosition {
  readonly rowId: string;
  readonly offsetWithinRow: number;
  readonly scrollOffset: number;
}

export function resolveThreadWorkGroupInitialScroll(
  rows: ReadonlyArray<{ readonly id: string }>,
  position: ThreadWorkGroupScrollPosition | undefined,
) {
  const index = position ? rows.findIndex((row) => row.id === position.rowId) : -1;
  return index >= 0 && position ? { index, viewOffset: -position.offsetWithinRow } : undefined;
}

export function resolveThreadFeedSubmissionAnchor<AnchorId>(input: {
  readonly currentAnchorMessageId: AnchorId | null;
  readonly submittedMessageId: AnchorId;
  readonly hasStartedTurn: boolean;
  readonly hasUserMessage: boolean;
  readonly queuedMessageCount: number;
  readonly deliveryDeferred: boolean;
}): AnchorId | null {
  if (input.deliveryDeferred || input.hasStartedTurn || input.hasUserMessage) {
    return null;
  }

  if (input.currentAnchorMessageId !== null) {
    return input.currentAnchorMessageId;
  }

  return input.queuedMessageCount > 0 ? null : input.submittedMessageId;
}

const JUMP_LANDING_LIMIT = 6;

/**
 * Lands on a message until it stops moving. Rows above an unvisited target are
 * estimates, so the first landing stops well away from it, and measuring the
 * rows there moves the target while the list holds the visible content still.
 */
export async function settleThreadFeedJump(input: {
  readonly land: () => Promise<void>;
  readonly position: () => number | undefined;
  readonly cancelled: () => boolean;
}): Promise<void> {
  let previous = input.position();
  for (let landing = 0; landing < JUMP_LANDING_LIMIT; landing += 1) {
    await input.land();
    if (input.cancelled()) return;
    const next = input.position();
    if (previous !== undefined && next !== undefined && Math.abs(next - previous) <= 1) return;
    previous = next;
  }
}
