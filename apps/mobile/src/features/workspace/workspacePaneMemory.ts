import { Atom } from "effect/reactivity";
import { appAtomRegistry } from "../../state/atom-registry";

export type WorkspacePane = "git" | "files";
const rememberedPane = Atom.family((key: string) =>
  Atom.make<WorkspacePane | null>(null).pipe(
    Atom.keepAlive,
    Atom.withLabel(`mobile:workspace:pane:${key}`),
  ),
);

export function readWorkspacePane(key: string) {
  return appAtomRegistry.get(rememberedPane(key));
}
export function rememberWorkspacePane(key: string, pane: WorkspacePane) {
  appAtomRegistry.set(rememberedPane(key), pane);
}

/** The first ready status chooses a pane once; later Git updates preserve that choice. */
export function resolveWorkspacePane(
  current: WorkspacePane | null,
  changedFiles: number | undefined,
): WorkspacePane | null {
  if (current !== null) return current;
  return changedFiles === undefined ? null : changedFiles > 0 ? "git" : "files";
}

export interface ThreadReviewSelection {
  readonly sectionId: string;
  readonly path?: string;
  readonly scope?: "staged" | "unstaged";
}

export interface ThreadWorkspaceLocation {
  readonly name: "Thread" | "ThreadReview" | "ThreadReviewFile" | "ThreadFiles" | "ThreadFile";
  readonly params: {
    readonly environmentId: string;
    readonly threadId: string;
    readonly reviewSectionId?: string;
    readonly reviewFilePath?: string;
    readonly reviewWorkingTreeScope?: "staged" | "unstaged";
    readonly path?: string[];
    readonly line?: string;
    readonly cwd?: string;
    readonly projectName?: string;
  };
}

const rememberedLocation = Atom.family((key: string) =>
  Atom.make<ThreadWorkspaceLocation | null>(null).pipe(
    Atom.keepAlive,
    Atom.withLabel(`mobile:workspace:location:${key}`),
  ),
);
const rememberedReviewSelection = Atom.family((key: string) =>
  Atom.make<ThreadReviewSelection | null>(null).pipe(
    Atom.keepAlive,
    Atom.withLabel(`mobile:workspace:review-selection:${key}`),
  ),
);

export function workspaceThreadMemoryKey(environmentId: string, threadId: string) {
  return JSON.stringify([environmentId, threadId]);
}

export function readThreadWorkspaceLocation(environmentId: string, threadId: string) {
  return appAtomRegistry.get(rememberedLocation(workspaceThreadMemoryKey(environmentId, threadId)));
}

export function rememberThreadWorkspaceLocation(location: ThreadWorkspaceLocation) {
  const key = workspaceThreadMemoryKey(location.params.environmentId, location.params.threadId);
  const atom = rememberedLocation(key);
  if (JSON.stringify(appAtomRegistry.get(atom)) !== JSON.stringify(location))
    appAtomRegistry.set(atom, location);
}

export function readThreadReviewSelection(key: string) {
  return appAtomRegistry.get(rememberedReviewSelection(key));
}

export function rememberThreadReviewSelection(key: string, selection: ThreadReviewSelection) {
  const atom = rememberedReviewSelection(key);
  if (JSON.stringify(appAtomRegistry.get(atom)) !== JSON.stringify(selection))
    appAtomRegistry.set(atom, selection);
}
