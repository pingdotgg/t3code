import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  isAbsolutePath,
  isWindowsAbsolutePath,
  normalizeProjectPathForComparison,
  workspaceRelativeFilePath,
} from "@t3tools/shared/path";

import { useRightPanelStore } from "./rightPanelStore";
import { resolvePathLinkTarget } from "@t3tools/shared/fileLinks";

interface OpenDiffFilePrimaryActionInput {
  readonly threadRef: ScopedThreadRef | null;
  readonly filePath: string;
  readonly activeCwd: string | undefined;
  readonly repositoryRoot?: string | undefined;
  readonly openInEditor: (targetPath: string) => void;
}

function normalizedRelativePathSegments(
  filePath: string,
  workspaceRoot: string | undefined,
): ReadonlyArray<string> | null {
  if (filePath.startsWith("/") || isWindowsAbsolutePath(filePath) || /^[a-zA-Z]:/.test(filePath)) {
    return null;
  }

  // Backslashes are legal filename characters on POSIX hosts.
  const path =
    workspaceRoot === undefined || isWindowsAbsolutePath(workspaceRoot)
      ? filePath.replaceAll("\\", "/")
      : filePath;
  const segments = path.split("/").filter((segment) => segment.length > 0 && segment !== ".");
  if (segments.length === 0 || segments.includes("..")) return null;
  return segments;
}

function repositoryRelativeWorkspaceSegments(
  workspaceRoot: string | undefined,
  repositoryRoot: string | undefined,
): ReadonlyArray<string> | null {
  if (!workspaceRoot || !repositoryRoot) return null;

  const normalizedWorkspaceRoot = normalizeProjectPathForComparison(workspaceRoot);
  const normalizedRepositoryRoot = normalizeProjectPathForComparison(repositoryRoot);
  if (normalizedWorkspaceRoot === normalizedRepositoryRoot) return [];

  const separator = normalizedRepositoryRoot.includes("\\") ? "\\" : "/";
  const repositoryPrefix = normalizedRepositoryRoot.endsWith(separator)
    ? normalizedRepositoryRoot
    : `${normalizedRepositoryRoot}${separator}`;
  if (!normalizedWorkspaceRoot.startsWith(repositoryPrefix)) return null;

  return normalizedWorkspaceRoot
    .slice(repositoryPrefix.length)
    .split(/[\\/]+/)
    .filter(Boolean);
}

export function resolveDiffPathForWorkspace(input: {
  readonly filePath: string;
  readonly workspaceRoot: string | undefined;
  readonly repositoryRoot: string | undefined;
}): string | null {
  // Claude and ACP tool-call diffs name files by absolute path.
  if (isAbsolutePath(input.filePath)) {
    const relativePath = workspaceRelativeFilePath(input.filePath, input.workspaceRoot);
    const segments =
      relativePath === null
        ? null
        : normalizedRelativePathSegments(relativePath, input.workspaceRoot);
    return segments ? segments.join("/") : null;
  }

  const fileSegments = normalizedRelativePathSegments(input.filePath, input.workspaceRoot);
  if (!fileSegments) return null;

  const workspaceSegments = repositoryRelativeWorkspaceSegments(
    input.workspaceRoot,
    input.repositoryRoot,
  );
  if (!workspaceSegments || workspaceSegments.length === 0) {
    return fileSegments.join("/");
  }

  const caseInsensitive = input.repositoryRoot
    ? isWindowsAbsolutePath(input.repositoryRoot)
    : false;
  const belongsToWorkspace = workspaceSegments.every((segment, index) => {
    const candidate = fileSegments[index];
    if (candidate === undefined) return false;
    return caseInsensitive ? candidate.toLowerCase() === segment : candidate === segment;
  });
  if (!belongsToWorkspace) return null;

  const relativeSegments = fileSegments.slice(workspaceSegments.length);
  return relativeSegments.length > 0 ? relativeSegments.join("/") : null;
}

export function openDiffFilePrimaryAction({
  threadRef,
  filePath,
  activeCwd,
  repositoryRoot,
  openInEditor,
}: OpenDiffFilePrimaryActionInput): void {
  const workspaceFilePath = resolveDiffPathForWorkspace({
    filePath,
    workspaceRoot: activeCwd,
    repositoryRoot,
  });
  if (!workspaceFilePath) return;

  if (threadRef) {
    useRightPanelStore.getState().openFile(threadRef, workspaceFilePath);
    return;
  }

  openInEditor(activeCwd ? resolvePathLinkTarget(workspaceFilePath, activeCwd) : workspaceFilePath);
}
