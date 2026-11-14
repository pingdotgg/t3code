export interface ViewedPress {
  readonly viewed: boolean;
  readonly version: number;
  /** Completed reads when the write landed: the press yields once a later read completes. */
  readonly awaitingReadAfter: number | undefined;
}

export interface ViewedState {
  readonly key: string;
  readonly presses: Readonly<Record<string, ViewedPress>>;
  readonly error: string | null;
}

/** The pressed states the server's read has not caught up with yet. */
export function viewedOverlay(
  presses: Readonly<Record<string, ViewedPress>>,
  reads: number,
): Record<string, boolean> {
  const overlay: Record<string, boolean> = {};
  for (const [path, press] of Object.entries(presses))
    if (press.awaitingReadAfter === undefined || press.awaitingReadAfter === reads)
      overlay[path] = press.viewed;
  return overlay;
}
