import type { PullRequestFileViewedState, PullRequestFilesViewedResult } from "@t3tools/contracts";

/** What the host last said about each file, by path. Absent means the host said nothing. */
export type FileViewedStates = ReadonlyMap<string, PullRequestFileViewedState>;

/** Presses the host has not confirmed yet, by path. */
export type FileViewedOverlay = ReadonlyMap<string, boolean>;

export function toFileViewedStates(
  result: PullRequestFilesViewedResult | null,
): FileViewedStates | null {
  if (result === null) return null;
  return new Map(result.files.map((file) => [file.path, file.state]));
}

/**
 * Whether a file counts as seen.
 *
 * `dismissed` is the host saying it has been pushed to since the reader cleared it, which reads
 * as unseen: the point of the tick is that the code behind it has been looked at, and it is not
 * the same code any more.
 */
export function isViewedState(state: PullRequestFileViewedState | undefined): boolean {
  return state === "viewed";
}

/** Whether the file was cleared and has since moved, which the header says out loud. */
export function isStaleViewedState(state: PullRequestFileViewedState | undefined): boolean {
  return state === "dismissed";
}

/** The press the reader made if it has not landed, and the host's answer otherwise. */
export function isFileViewed(
  path: string,
  states: FileViewedStates | null,
  overlay: FileViewedOverlay,
): boolean {
  const pressed = overlay.get(path);
  return pressed ?? isViewedState(states?.get(path));
}

export function countViewedFiles(
  paths: ReadonlyArray<string>,
  states: FileViewedStates | null,
  overlay: FileViewedOverlay,
): number {
  return paths.reduce(
    (total, path) => (isFileViewed(path, states, overlay) ? total + 1 : total),
    0,
  );
}

/**
 * The overlay with everything the host has caught up on removed.
 *
 * A press is held locally until the host's own answer agrees with it, rather than cleared when
 * the request succeeds: the read that follows a write is a separate round trip, and dropping the
 * press in between would flash the checkbox back for as long as that took.
 *
 * `unsettled` are the paths whose press the host cannot have heard yet, which an answer that was
 * already on its way when they were pressed must not be allowed to overrule.
 */
export function settleFileViewedOverlay(
  overlay: FileViewedOverlay,
  states: FileViewedStates | null,
  unsettled: ReadonlySet<string>,
): FileViewedOverlay {
  if (states === null || overlay.size === 0) return overlay;
  const next = new Map(overlay);
  for (const [path, pressed] of overlay) {
    if (unsettled.has(path)) continue;
    if (isViewedState(states.get(path)) === pressed) next.delete(path);
  }
  return next.size === overlay.size ? overlay : next;
}

/**
 * The overlay with a failed request's presses taken back.
 *
 * `owned` are the paths that request still answers for, which is what keeps a failure from
 * reaching past its own presses: a path pressed again since belongs to a later request or to the
 * next flush, and putting that box back to the host's answer would take a press out from under
 * the reader's hand. Even among those, a press is only taken back where the checkbox still shows
 * it.
 */
export function revertFileViewedOverlay(
  overlay: FileViewedOverlay,
  batch: ReadonlyArray<{ readonly path: string; readonly viewed: boolean }>,
  owned: ReadonlySet<string>,
): FileViewedOverlay {
  const next = new Map(overlay);
  for (const { path, viewed } of batch) {
    if (!owned.has(path)) continue;
    if (next.get(path) === viewed) next.delete(path);
  }
  return next.size === overlay.size ? overlay : next;
}

/** The presses in an overlay as the batch the host is told about. */
export function toFileViewedBatch(
  overlay: FileViewedOverlay,
): ReadonlyArray<{ readonly path: string; readonly viewed: boolean }> {
  return [...overlay].map(([path, viewed]) => ({ path, viewed }));
}
