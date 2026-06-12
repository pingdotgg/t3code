import type { EnvironmentId, TurnId } from "@t3tools/contracts";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";

import type { DiffRouteSource } from "./diffRouteSearch";
import { openInPreferredEditor } from "./editorPreferences";
import { readLocalApi } from "./localApi";
import { openRightPanel } from "./rightPanelGesture";
import { splitPathAndPosition } from "./terminal-links";

export interface WorkspaceFilePreviewDiffReturnTarget {
  kind: "diff";
  diffSource?: DiffRouteSource;
  diffTurnId?: TurnId;
  diffFilePath?: string;
}

export interface WorkspaceFilePreviewExplorerReturnTarget {
  kind: "explorer";
}

export interface WorkspaceFilePreviewSourceControlReturnTarget {
  kind: "source-control";
}

export type WorkspaceFilePreviewReturnTarget =
  | WorkspaceFilePreviewDiffReturnTarget
  | WorkspaceFilePreviewExplorerReturnTarget
  | WorkspaceFilePreviewSourceControlReturnTarget;

export interface WorkspaceFilePreviewTarget {
  environmentId: EnvironmentId;
  cwd: string;
  relativePath: string;
  displayPath: string;
  line?: number;
  column?: number;
}

export interface WorkspaceFileExplorerContext {
  environmentId: EnvironmentId;
  cwd: string;
  projectName?: string;
}

export interface WorkspaceFilePreviewReturnPreview {
  target: WorkspaceFilePreviewTarget;
  returnTarget: WorkspaceFilePreviewReturnTarget | null;
}

export type WorkspaceFilePanelView = "explorer" | "preview" | "source-control";

export interface WorkspaceFilePanelPreviewHistoryEntry {
  kind: "preview";
  explorerContext: WorkspaceFileExplorerContext | null;
  target: WorkspaceFilePreviewTarget;
}

export interface WorkspaceFilePanelExplorerHistoryEntry {
  kind: "explorer";
  context: WorkspaceFileExplorerContext;
}

export type WorkspaceFilePanelHistoryEntry =
  | WorkspaceFilePreviewDiffReturnTarget
  | WorkspaceFilePanelExplorerHistoryEntry
  | WorkspaceFilePanelPreviewHistoryEntry
  | WorkspaceFilePreviewSourceControlReturnTarget;

const MAX_WORKSPACE_FILE_PANEL_HISTORY_LENGTH = 50;

interface WorkspaceFilePreviewState {
  open: boolean;
  view: WorkspaceFilePanelView;
  target: WorkspaceFilePreviewTarget | null;
  activeExplorerContext: WorkspaceFileExplorerContext | null;
  explorerContext: WorkspaceFileExplorerContext | null;
  explorerReturnPreview: WorkspaceFilePreviewReturnPreview | null;
  history: ReadonlyArray<WorkspaceFilePanelHistoryEntry>;
  returnTarget: WorkspaceFilePreviewReturnTarget | null;
  openPreview: (
    target: WorkspaceFilePreviewTarget,
    options?: { returnTarget?: WorkspaceFilePreviewReturnTarget | null },
  ) => void;
  openExplorer: (
    context: WorkspaceFileExplorerContext,
    options?: { returnToPreview?: WorkspaceFilePreviewReturnPreview | null },
  ) => void;
  openSourceControl: () => void;
  reopenPanel: () => void;
  reopenPreview: () => void;
  returnBack: () => void;
  returnExplorerToPreview: () => void;
  returnPreviewToExplorer: (context: WorkspaceFileExplorerContext) => void;
  setActiveExplorerContext: (context: WorkspaceFileExplorerContext | null) => void;
  closePreview: () => void;
  closeSourceControl: () => void;
}

function sameExplorerContextWorkspace(
  left: WorkspaceFileExplorerContext | null,
  right: WorkspaceFileExplorerContext | null,
): boolean {
  return (
    left !== null &&
    right !== null &&
    left.environmentId === right.environmentId &&
    left.cwd === right.cwd
  );
}

function sameTargetWorkspace(
  target: WorkspaceFilePreviewTarget | null,
  context: WorkspaceFileExplorerContext | null,
): boolean {
  return (
    target !== null &&
    context !== null &&
    target.environmentId === context.environmentId &&
    target.cwd === context.cwd
  );
}

function sameOptionalExplorerContext(
  left: WorkspaceFileExplorerContext | null,
  right: WorkspaceFileExplorerContext | null,
): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return sameExplorerContextWorkspace(left, right);
}

function deriveExplorerContextFromTarget(
  target: WorkspaceFilePreviewTarget,
  existingContext: WorkspaceFileExplorerContext | null,
  activeContext: WorkspaceFileExplorerContext | null,
): WorkspaceFileExplorerContext {
  if (activeContext && sameTargetWorkspace(target, activeContext)) {
    return activeContext;
  }
  if (existingContext && sameTargetWorkspace(target, existingContext)) {
    return existingContext;
  }
  return {
    environmentId: target.environmentId,
    cwd: target.cwd,
  };
}

function samePreviewTarget(
  left: WorkspaceFilePreviewTarget,
  right: WorkspaceFilePreviewTarget,
): boolean {
  return (
    left.environmentId === right.environmentId &&
    left.cwd === right.cwd &&
    left.relativePath === right.relativePath &&
    left.displayPath === right.displayPath &&
    left.line === right.line &&
    left.column === right.column
  );
}

function sameDiffReturnTarget(
  left: WorkspaceFilePreviewDiffReturnTarget,
  right: WorkspaceFilePreviewDiffReturnTarget,
): boolean {
  return (
    left.diffSource === right.diffSource &&
    left.diffTurnId === right.diffTurnId &&
    left.diffFilePath === right.diffFilePath
  );
}

function sameHistoryEntry(
  left: WorkspaceFilePanelHistoryEntry,
  right: WorkspaceFilePanelHistoryEntry,
): boolean {
  if (left.kind !== right.kind) {
    return false;
  }

  switch (left.kind) {
    case "diff":
      return sameDiffReturnTarget(left, right as WorkspaceFilePreviewDiffReturnTarget);
    case "explorer":
      return sameExplorerContextWorkspace(
        left.context,
        (right as WorkspaceFilePanelExplorerHistoryEntry).context,
      );
    case "preview": {
      const previewRight = right as WorkspaceFilePanelPreviewHistoryEntry;
      return (
        samePreviewTarget(left.target, previewRight.target) &&
        sameOptionalExplorerContext(left.explorerContext, previewRight.explorerContext)
      );
    }
    case "source-control":
      return true;
  }
}

function appendHistoryEntry(
  history: ReadonlyArray<WorkspaceFilePanelHistoryEntry>,
  entry: WorkspaceFilePanelHistoryEntry,
): ReadonlyArray<WorkspaceFilePanelHistoryEntry> {
  const previousEntry = history[history.length - 1];
  if (previousEntry && sameHistoryEntry(previousEntry, entry)) {
    return history;
  }

  const nextHistory = [...history, entry];
  return nextHistory.length > MAX_WORKSPACE_FILE_PANEL_HISTORY_LENGTH
    ? nextHistory.slice(nextHistory.length - MAX_WORKSPACE_FILE_PANEL_HISTORY_LENGTH)
    : nextHistory;
}

function currentHistoryEntry(
  state: WorkspaceFilePreviewState,
): WorkspaceFilePanelHistoryEntry | null {
  if (!state.open) {
    return null;
  }

  switch (state.view) {
    case "explorer":
      return state.explorerContext ? { kind: "explorer", context: state.explorerContext } : null;
    case "preview":
      return state.target
        ? {
            kind: "preview",
            explorerContext: state.explorerContext,
            target: state.target,
          }
        : null;
    case "source-control":
      return { kind: "source-control" };
  }
}

function historyEntryFromReturnTarget(
  returnTarget: WorkspaceFilePreviewReturnTarget | null | undefined,
): WorkspaceFilePanelHistoryEntry | null {
  if (!returnTarget) {
    return null;
  }
  if (returnTarget.kind === "diff") {
    return returnTarget;
  }
  if (returnTarget.kind === "source-control") {
    return { kind: "source-control" };
  }
  return null;
}

function previewHistoryEntryFromReturnPreview(
  returnPreview: WorkspaceFilePreviewReturnPreview,
): WorkspaceFilePanelPreviewHistoryEntry {
  return {
    kind: "preview",
    explorerContext: deriveExplorerContextFromTarget(returnPreview.target, null, null),
    target: returnPreview.target,
  };
}

function returnTargetFromHistoryEntry(
  entry: WorkspaceFilePanelHistoryEntry | null | undefined,
): WorkspaceFilePreviewReturnTarget | null {
  if (!entry) {
    return null;
  }

  switch (entry.kind) {
    case "diff":
      return entry;
    case "explorer":
      return { kind: "explorer" };
    case "source-control":
      return { kind: "source-control" };
    case "preview":
      return null;
  }
}

function returnTargetForHistory(
  history: ReadonlyArray<WorkspaceFilePanelHistoryEntry>,
): WorkspaceFilePreviewReturnTarget | null {
  return returnTargetFromHistoryEntry(history[history.length - 1]);
}

function historyWithCurrentEntry(
  state: WorkspaceFilePreviewState,
  destination?: WorkspaceFilePanelHistoryEntry,
): ReadonlyArray<WorkspaceFilePanelHistoryEntry> {
  const currentEntry = currentHistoryEntry(state);
  if (!currentEntry || (destination && sameHistoryEntry(currentEntry, destination))) {
    return state.history;
  }
  return appendHistoryEntry(state.history, currentEntry);
}

function restoreHistoryEntry(
  state: WorkspaceFilePreviewState,
  entry: Exclude<WorkspaceFilePanelHistoryEntry, WorkspaceFilePreviewDiffReturnTarget>,
  history: ReadonlyArray<WorkspaceFilePanelHistoryEntry>,
): Partial<WorkspaceFilePreviewState> {
  switch (entry.kind) {
    case "explorer":
      return {
        open: true,
        view: "explorer",
        explorerContext: entry.context,
        explorerReturnPreview: null,
        history,
        returnTarget: null,
      };
    case "preview":
      return {
        open: true,
        view: "preview",
        target: entry.target,
        explorerContext: deriveExplorerContextFromTarget(
          entry.target,
          entry.explorerContext,
          state.activeExplorerContext,
        ),
        explorerReturnPreview: null,
        history,
        returnTarget: returnTargetForHistory(history),
      };
    case "source-control":
      return {
        open: true,
        view: "source-control",
        explorerReturnPreview: null,
        history,
        returnTarget: null,
      };
  }
}

export function workspaceFilePanelBackButtonLabel(target: WorkspaceFilePanelHistoryEntry): string {
  switch (target.kind) {
    case "diff":
      return "Back to diff";
    case "explorer":
      return "Back to explorer";
    case "preview":
      return "Back to file viewer";
    case "source-control":
      return "Back to source control";
  }
}

const useWorkspaceFilePreviewStore = create<WorkspaceFilePreviewState>((set) => ({
  open: false,
  view: "preview",
  target: null,
  activeExplorerContext: null,
  explorerContext: null,
  explorerReturnPreview: null,
  history: [],
  returnTarget: null,
  openPreview: (target, options) =>
    set((state) => {
      const explorerContext = deriveExplorerContextFromTarget(
        target,
        state.explorerContext,
        state.activeExplorerContext,
      );
      const destination = {
        kind: "preview",
        explorerContext,
        target,
      } satisfies WorkspaceFilePanelPreviewHistoryEntry;
      let history = historyWithCurrentEntry(state, destination);
      const explicitReturnEntry = historyEntryFromReturnTarget(options?.returnTarget);

      if (state.open && state.view === "source-control" && explicitReturnEntry?.kind === "diff") {
        history = appendHistoryEntry(history, explicitReturnEntry);
      }

      if (!state.open) {
        if (explicitReturnEntry) {
          history = appendHistoryEntry(history, explicitReturnEntry);
        }
      }

      return {
        open: true,
        view: "preview",
        target,
        explorerContext,
        explorerReturnPreview: null,
        history,
        returnTarget: returnTargetForHistory(history),
      };
    }),
  openExplorer: (context, options) =>
    set((state) => {
      const destination = {
        kind: "explorer",
        context,
      } satisfies WorkspaceFilePanelExplorerHistoryEntry;
      let history: ReadonlyArray<WorkspaceFilePanelHistoryEntry> =
        state.open && state.view === "explorer" && !options?.returnToPreview
          ? []
          : historyWithCurrentEntry(state, destination);
      const fallbackReturnPreview = !state.open ? (options?.returnToPreview ?? null) : null;

      if (fallbackReturnPreview) {
        const fallbackEntry = historyEntryFromReturnTarget(fallbackReturnPreview.returnTarget);
        if (fallbackEntry) {
          history = appendHistoryEntry(history, fallbackEntry);
        }
        history = appendHistoryEntry(
          history,
          previewHistoryEntryFromReturnPreview(fallbackReturnPreview),
        );
      }

      return {
        open: true,
        view: "explorer",
        explorerContext: context,
        explorerReturnPreview: fallbackReturnPreview,
        history,
        returnTarget: null,
      };
    }),
  openSourceControl: () =>
    set((state) => {
      const history = historyWithCurrentEntry(state, { kind: "source-control" });
      return {
        open: true,
        view: "source-control",
        explorerReturnPreview: null,
        history,
        returnTarget: null,
      };
    }),
  reopenPanel: () =>
    set((state) => {
      const activeContext = state.activeExplorerContext;
      const storedExplorerMatchesActive = sameExplorerContextWorkspace(
        state.explorerContext,
        activeContext,
      );
      const storedTargetMatchesActive = sameTargetWorkspace(state.target, activeContext);

      if (state.open && state.view === "source-control") {
        const history = historyWithCurrentEntry(state);
        if (state.target) {
          return {
            ...state,
            open: true,
            view: "preview",
            explorerReturnPreview: null,
            history,
            returnTarget: returnTargetForHistory(history),
          };
        }
        if (state.explorerContext) {
          return {
            ...state,
            open: true,
            view: "explorer",
            explorerReturnPreview: null,
            history,
            returnTarget: null,
          };
        }
      }

      if (activeContext && !storedExplorerMatchesActive && !storedTargetMatchesActive) {
        return {
          ...state,
          open: true,
          view: "explorer",
          target: null,
          explorerContext: activeContext,
          explorerReturnPreview: null,
          history: [],
          returnTarget: null,
        };
      }

      if (!state.target && !state.explorerContext) {
        if (!activeContext) {
          return state;
        }
        return {
          ...state,
          open: true,
          view: "explorer",
          explorerContext: activeContext,
          explorerReturnPreview: null,
          history: [],
          returnTarget: null,
        };
      }

      if (state.view === "explorer") {
        return {
          ...state,
          open: true,
          explorerContext:
            activeContext && storedExplorerMatchesActive ? activeContext : state.explorerContext,
        };
      }

      if (state.target) {
        return { ...state, open: true, view: "preview" };
      }
      return { ...state, open: true, view: "explorer" };
    }),
  reopenPreview: () =>
    set((state) => {
      if (!state.target || (state.open && state.view === "preview")) {
        return state;
      }
      const history = state.open ? historyWithCurrentEntry(state) : state.history;
      return {
        ...state,
        open: true,
        view: "preview",
        explorerReturnPreview: null,
        history,
        returnTarget: returnTargetForHistory(history),
      };
    }),
  setActiveExplorerContext: (context) =>
    set((state) => {
      if (
        sameExplorerContextWorkspace(state.activeExplorerContext, context) &&
        state.activeExplorerContext?.projectName === context?.projectName
      ) {
        return state;
      }

      const nextState = { ...state, activeExplorerContext: context };
      if (
        context &&
        sameExplorerContextWorkspace(state.explorerContext, context) &&
        state.explorerContext?.projectName !== context.projectName
      ) {
        return {
          ...nextState,
          explorerContext: context,
        };
      }

      return nextState;
    }),
  returnBack: () =>
    set((state) => {
      const previousEntry = state.history[state.history.length - 1];
      if (!previousEntry || previousEntry.kind === "diff") {
        return state;
      }

      return {
        ...state,
        ...restoreHistoryEntry(state, previousEntry, state.history.slice(0, -1)),
      };
    }),
  returnExplorerToPreview: () =>
    set((state) => {
      const previousEntry = state.history[state.history.length - 1];
      if (previousEntry?.kind === "preview") {
        return {
          ...state,
          ...restoreHistoryEntry(state, previousEntry, state.history.slice(0, -1)),
        };
      }
      if (!state.explorerReturnPreview) {
        return state;
      }
      const history = state.history.slice(0, -1);
      return {
        ...state,
        open: true,
        view: "preview",
        target: state.explorerReturnPreview.target,
        explorerContext: deriveExplorerContextFromTarget(
          state.explorerReturnPreview.target,
          state.explorerContext,
          state.activeExplorerContext,
        ),
        history,
        returnTarget: returnTargetForHistory(history),
        explorerReturnPreview: null,
      };
    }),
  returnPreviewToExplorer: (context) =>
    set((state) => {
      const previousEntry = state.history[state.history.length - 1];
      if (previousEntry?.kind === "explorer") {
        return {
          ...state,
          ...restoreHistoryEntry(state, previousEntry, state.history.slice(0, -1)),
        };
      }
      return {
        ...state,
        open: true,
        view: "explorer",
        explorerContext: context,
        explorerReturnPreview: null,
        history: [],
        returnTarget: null,
      };
    }),
  closePreview: () =>
    set((state) =>
      state.open || state.returnTarget || state.explorerReturnPreview || state.history.length > 0
        ? {
            ...state,
            open: false,
            returnTarget: null,
            explorerReturnPreview: null,
            history: [],
          }
        : state,
    ),
  closeSourceControl: () =>
    set((state) =>
      state.open && state.view === "source-control"
        ? { ...state, open: false, history: [], returnTarget: null, explorerReturnPreview: null }
        : state,
    ),
}));

function normalizePathSeparators(value: string): string {
  return value.replaceAll("\\", "/");
}

function trimTrailingSeparators(value: string): string {
  return value.replace(/[\\/]+$/, "");
}

function stripRelativePrefix(value: string): string {
  return normalizePathSeparators(value)
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "");
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

function parseOptionalPositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function resolveWorkspaceFilePreviewTarget(input: {
  environmentId: EnvironmentId;
  cwd: string;
  targetPath: string;
  displayPath?: string;
}): WorkspaceFilePreviewTarget | null {
  const { path, line, column } = splitPathAndPosition(input.targetPath);
  const normalizedPath = normalizePathSeparators(path);
  const normalizedCwd = normalizePathSeparators(trimTrailingSeparators(input.cwd));

  let relativePath: string | null = null;
  if (isAbsolutePath(path)) {
    const comparePath = normalizedPath.toLowerCase();
    const compareCwd = normalizedCwd.toLowerCase();
    const cwdWithSeparator = `${compareCwd}/`;
    if (comparePath.startsWith(cwdWithSeparator)) {
      relativePath = normalizedPath.slice(normalizedCwd.length + 1);
    }
  } else {
    relativePath = stripRelativePrefix(path);
  }

  if (
    !relativePath ||
    relativePath === "." ||
    relativePath === ".." ||
    relativePath.startsWith("../")
  ) {
    return null;
  }
  const lineNumber = parseOptionalPositiveInt(line);
  const columnNumber = parseOptionalPositiveInt(column);

  const target: WorkspaceFilePreviewTarget = {
    environmentId: input.environmentId,
    cwd: input.cwd,
    relativePath,
    displayPath: input.displayPath ?? relativePath,
  };
  if (lineNumber !== undefined) {
    target.line = lineNumber;
  }
  if (columnNumber !== undefined) {
    target.column = columnNumber;
  }
  return target;
}

function isNoAvailableEditorsError(error: unknown): boolean {
  return error instanceof Error && error.message === "No available editors found.";
}

export function openWorkspaceFilePreview(
  target: WorkspaceFilePreviewTarget,
  options?: { returnTarget?: WorkspaceFilePreviewReturnTarget | null },
): void {
  useWorkspaceFilePreviewStore.getState().openPreview(target, options);
  openRightPanel("file");
}

export function openWorkspaceFileExplorer(
  context: WorkspaceFileExplorerContext,
  options?: { returnToPreview?: WorkspaceFilePreviewReturnPreview | null },
): void {
  useWorkspaceFilePreviewStore.getState().openExplorer(context, options);
  openRightPanel("file");
}

export function openWorkspaceSourceControlPanel(): void {
  useWorkspaceFilePreviewStore.getState().openSourceControl();
}

export async function openPathInPreferredEditorOrFilePreview(input: {
  targetPath: string;
  environmentId?: EnvironmentId | undefined;
  cwd?: string | undefined;
  displayPath?: string | undefined;
  returnTarget?: WorkspaceFilePreviewReturnTarget | null | undefined;
}): Promise<"editor" | "preview"> {
  const api = readLocalApi();
  if (api) {
    try {
      await openInPreferredEditor(api, input.targetPath);
      return "editor";
    } catch (error) {
      if (!isNoAvailableEditorsError(error)) {
        throw error;
      }
    }
  }

  if (input.environmentId && input.cwd) {
    const target = resolveWorkspaceFilePreviewTarget({
      environmentId: input.environmentId,
      cwd: input.cwd,
      targetPath: input.targetPath,
      ...(input.displayPath ? { displayPath: input.displayPath } : {}),
    });
    if (target) {
      openWorkspaceFilePreview(target, { returnTarget: input.returnTarget ?? null });
      return "preview";
    }
  }

  throw new Error(api ? "No available editors found." : "Local API not found");
}

export function useWorkspaceFilePreviewState() {
  return useWorkspaceFilePreviewStore(
    useShallow((state) => ({
      open: state.open,
      view: state.view,
      target: state.target,
      activeExplorerContext: state.activeExplorerContext,
      explorerContext: state.explorerContext,
      explorerReturnPreview: state.explorerReturnPreview,
      history: state.history,
      returnTarget: state.returnTarget,
    })),
  );
}

export const useWorkspaceFilePanelState = useWorkspaceFilePreviewState;

export function closeWorkspaceFilePreview(): void {
  useWorkspaceFilePreviewStore.getState().closePreview();
}

export function closeWorkspaceSourceControlPanel(): void {
  useWorkspaceFilePreviewStore.getState().closeSourceControl();
}

export function reopenWorkspaceFilePreview(): void {
  useWorkspaceFilePreviewStore.getState().reopenPreview();
}

export function reopenWorkspaceFilePanel(): void {
  useWorkspaceFilePreviewStore.getState().reopenPanel();
}

export function setActiveWorkspaceFileExplorerContext(
  context: WorkspaceFileExplorerContext | null,
): void {
  useWorkspaceFilePreviewStore.getState().setActiveExplorerContext(context);
}

export function __readWorkspaceFilePanelStateForTests() {
  const {
    open,
    view,
    target,
    activeExplorerContext,
    explorerContext,
    explorerReturnPreview,
    history,
    returnTarget,
  } = useWorkspaceFilePreviewStore.getState();
  return {
    open,
    view,
    target,
    activeExplorerContext,
    explorerContext,
    explorerReturnPreview,
    history,
    returnTarget,
  };
}

export function __resetWorkspaceFilePanelStateForTests(): void {
  useWorkspaceFilePreviewStore.setState({
    open: false,
    view: "preview",
    target: null,
    activeExplorerContext: null,
    explorerContext: null,
    explorerReturnPreview: null,
    history: [],
    returnTarget: null,
  });
}

export function returnWorkspaceFilePanelBack(): void {
  useWorkspaceFilePreviewStore.getState().returnBack();
}

export function returnWorkspaceFileExplorerToPreview(): void {
  useWorkspaceFilePreviewStore.getState().returnExplorerToPreview();
}

export function returnWorkspaceFilePreviewToExplorer(context: WorkspaceFileExplorerContext): void {
  useWorkspaceFilePreviewStore.getState().returnPreviewToExplorer(context);
}
