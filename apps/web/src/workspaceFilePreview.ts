import type { EnvironmentId, TurnId } from "@t3tools/contracts";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";

import { openInPreferredEditor } from "./editorPreferences";
import { readLocalApi } from "./localApi";
import { openRightPanel } from "./rightPanelGesture";
import { splitPathAndPosition } from "./terminal-links";

export interface WorkspaceFilePreviewReturnTarget {
  kind: "diff";
  diffTurnId?: TurnId;
  diffFilePath?: string;
}

export interface WorkspaceFilePreviewTarget {
  environmentId: EnvironmentId;
  cwd: string;
  relativePath: string;
  displayPath: string;
  line?: number;
  column?: number;
}

interface WorkspaceFilePreviewState {
  open: boolean;
  target: WorkspaceFilePreviewTarget | null;
  returnTarget: WorkspaceFilePreviewReturnTarget | null;
  openPreview: (
    target: WorkspaceFilePreviewTarget,
    options?: { returnTarget?: WorkspaceFilePreviewReturnTarget | null },
  ) => void;
  reopenPreview: () => void;
  closePreview: () => void;
}

const useWorkspaceFilePreviewStore = create<WorkspaceFilePreviewState>((set) => ({
  open: false,
  target: null,
  returnTarget: null,
  openPreview: (target, options) =>
    set({ open: true, target, returnTarget: options?.returnTarget ?? null }),
  reopenPreview: () =>
    set((state) => (state.target && !state.open ? { ...state, open: true } : state)),
  closePreview: () =>
    set((state) => (state.open ? { ...state, open: false, returnTarget: null } : state)),
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
      target: state.target,
      returnTarget: state.returnTarget,
    })),
  );
}

export function closeWorkspaceFilePreview(): void {
  useWorkspaceFilePreviewStore.getState().closePreview();
}

export function reopenWorkspaceFilePreview(): void {
  useWorkspaceFilePreviewStore.getState().reopenPreview();
}
