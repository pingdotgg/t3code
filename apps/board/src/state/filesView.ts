import { Atom, type AtomRegistry } from "effect/reactivity";

import { checksPickAtom } from "./checksView";

/** What a diff tab compares: the working tree against HEAD, the branch against its base, or one commit. */
export type DiffSource =
  | { readonly kind: "working-tree" }
  | { readonly kind: "branch-range"; readonly baseRef: string | null }
  | { readonly kind: "commit"; readonly sha: string };

/**
 * A tab of the main view addressed the way the engine takes it: relative to the root it was listed
 * under. With a `diff` it is that file's diff, or every changed file's when `path` is empty.
 */
export interface FileRef {
  readonly cwd: string;
  readonly path: string;
  /** The line a file opens at, which the file view scrolls to and marks. */
  readonly line?: number;
  readonly diff?: DiffSource;
}

/** Which browser tab the main view shows: a page, or the agents' tabs. */
export type Surface = "page" | "agents";

/** The explorer's root, the files open as tabs beside the board, and which tab the main view shows. */
export interface FilesViewState {
  /** The root the explorer browses, or null for the project. */
  readonly root: string | null;
  readonly tabs: ReadonlyArray<FileRef>;
  /** The file tab shown in place of the board's canvas, or null while the canvas or a browser tab shows. */
  readonly active: FileRef | null;
  /** The browser tab shown in place of the canvas, or null while the canvas or a file shows. */
  readonly surface: Surface | null;
}

export const filesViewAtom = Atom.make<FilesViewState>({
  root: null,
  tabs: [],
  active: null,
  surface: null,
}).pipe(Atom.keepAlive, Atom.withLabel("files-view"));

/** The identity of a tab: a line request does not make a second tab, and a diff is not the file it shows. */
export const fileKey = (file: FileRef) =>
  `${file.cwd}\0${file.path}\0${file.diff === undefined ? "" : JSON.stringify(file.diff)}`;

export const sameFile = (a: FileRef, b: FileRef) => fileKey(a) === fileKey(b);

const change = (
  registry: AtomRegistry.AtomRegistry,
  next: (state: FilesViewState) => FilesViewState,
) => registry.set(filesViewAtom, next(registry.get(filesViewAtom)));

/** Browses another root. The Checks tab follows the root, so a ticket picked there no longer applies. */
export function chooseRoot(registry: AtomRegistry.AtomRegistry, root: string) {
  registry.set(checksPickAtom, null);
  change(registry, (state) => ({ ...state, root }));
}

/** Opens a file or a diff as a tab, or shows the tab it already has, at the line it names. */
export function openFile(registry: AtomRegistry.AtomRegistry, file: FileRef) {
  performance.mark(file.diff === undefined ? "board:preview-open" : "board:diff-open", {
    detail: { path: file.path },
  });
  change(registry, (state) => ({
    ...state,
    tabs: state.tabs.some((tab) => sameFile(tab, file))
      ? state.tabs.map((tab) => (sameFile(tab, file) ? file : tab))
      : [...state.tabs, file],
    active: file,
    surface: null,
  }));
}

/** Shows the board's canvas again, and leaves the files and browser tabs open. */
export const showBoard = (registry: AtomRegistry.AtomRegistry) =>
  change(registry, (state) => ({ ...state, active: null, surface: null }));

export const showFile = (registry: AtomRegistry.AtomRegistry, file: FileRef) =>
  change(registry, (state) => ({ ...state, active: file, surface: null }));

export const showSurface = (registry: AtomRegistry.AtomRegistry, surface: Surface) =>
  change(registry, (state) => ({ ...state, active: null, surface }));

/** Closes a tab. Closing the one shown moves to the tab before it, or back to the canvas. */
export const closeFile = (registry: AtomRegistry.AtomRegistry, file: FileRef) =>
  change(registry, (state) => {
    const index = state.tabs.findIndex((tab) => sameFile(tab, file));
    const tabs = state.tabs.filter((tab) => !sameFile(tab, file));
    const shown = state.active !== null && sameFile(state.active, file);
    return { ...state, tabs, active: shown ? (tabs[index - 1] ?? null) : state.active };
  });
