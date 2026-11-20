import { Atom, type AtomRegistry } from "effect/reactivity";

/** A file addressed the way the engine takes it: relative to the root it was listed under. */
export interface FileRef {
  readonly cwd: string;
  readonly path: string;
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

export const sameFile = (a: FileRef, b: FileRef) => a.cwd === b.cwd && a.path === b.path;

const change = (
  registry: AtomRegistry.AtomRegistry,
  next: (state: FilesViewState) => FilesViewState,
) => registry.set(filesViewAtom, next(registry.get(filesViewAtom)));

export const chooseRoot = (registry: AtomRegistry.AtomRegistry, root: string) =>
  change(registry, (state) => ({ ...state, root }));

/** Opens a file as a tab, or shows the tab it already has. */
export function openFile(registry: AtomRegistry.AtomRegistry, file: FileRef) {
  performance.mark("board:preview-open", { detail: { path: file.path } });
  change(registry, (state) => ({
    ...state,
    tabs: state.tabs.some((tab) => sameFile(tab, file)) ? state.tabs : [...state.tabs, file],
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
