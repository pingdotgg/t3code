import type { PullRequestFilesViewedResult } from "@t3tools/contracts";

export type FilesViewedRead = PullRequestFilesViewedResult | null;

export interface ViewedPress {
  readonly viewed: boolean;
  readonly version: number;
  /** Set once the write lands: the press yields to the server once a read newer than this lands. */
  readonly awaitingReadAfter: { readonly read: FilesViewedRead } | undefined;
}

export interface ViewedState {
  readonly key: string;
  readonly presses: Readonly<Record<string, ViewedPress>>;
  readonly error: string | null;
}

/** The pressed states the server's read has not caught up with yet. */
export function viewedOverlay(
  presses: Readonly<Record<string, ViewedPress>>,
  read: FilesViewedRead,
): Record<string, boolean> {
  const overlay: Record<string, boolean> = {};
  for (const [path, press] of Object.entries(presses))
    if (press.awaitingReadAfter === undefined || press.awaitingReadAfter.read === read)
      overlay[path] = press.viewed;
  return overlay;
}
