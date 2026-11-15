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
  windowsRoot: boolean,
): ReadonlyArray<string> | null {
  if (filePath.startsWith("/") || isWindowsAbsolutePath(filePath) || /^[a-zA-Z]:/.test(filePath)) {
    return null;
  }

  // On POSIX a backslash is part of a file name; Windows treats it as a separator
  // (tool-call patches can name files with either), so reject ".." either way.
  const parts = filePath.split(/[\\/]/);
  if (parts.includes("..")) return null;
  const segments = (windowsRoot ? parts : filePath.split("/")).filter(
    (segment) => segment.length > 0 && segment !== ".",
  );
  if (segments.length === 0) return null;
  return segments;
}

/** Segments of `descendant` below `root`, or null when it is not below it. */
function relativePathSegments(root: string, descendant: string): ReadonlyArray<string> | null {
  const normalizedRoot = normalizeProjectPathForComparison(root);
  const normalizedDescendant = normalizeProjectPathForComparison(descendant);
  if (normalizedRoot === normalizedDescendant) return [];

  const windowsRoot = isWindowsAbsolutePath(normalizedRoot);
  const separator = windowsRoot ? "\\" : "/";
  const rootPrefix = normalizedRoot.endsWith(separator)
    ? normalizedRoot
    : `${normalizedRoot}${separator}`;
  if (!normalizedDescendant.startsWith(rootPrefix)) return null;

  // Keep the descendant's case for the path we build; only the comparison is case-insensitive.
  const descendantSegments = windowsRoot ? descendant.split(/[\\/]/) : descendant.split("/");
  return descendantSegments
    .filter(Boolean)
    .slice(rootPrefix.split(separator).filter(Boolean).length);
}

function repositoryRelativeWorkspaceSegments(
  workspaceRoot: string | undefined,
  repositoryRoot: string | undefined,
): ReadonlyArray<string> | null {
  if (!workspaceRoot || !repositoryRoot) return null;
  return relativePathSegments(repositoryRoot, workspaceRoot);
}

function workspaceRelativeRepositorySegments(
  workspaceRoot: string | undefined,
  repositoryRoot: string | undefined,
): ReadonlyArray<string> | null {
  if (!workspaceRoot || !repositoryRoot) return null;
  return relativePathSegments(workspaceRoot, repositoryRoot);
}

export function resolveDiffPathForWorkspace(input: {
  readonly filePath: string;
  readonly workspaceRoot: string | undefined;
  readonly repositoryRoot: string | undefined;
}): string | null {
  const windowsRoot = [input.workspaceRoot, input.repositoryRoot].some(
    (root) => root !== undefined && isWindowsAbsolutePath(root),
  );
  // Claude and ACP tool-call diffs name files by absolute path.
  if (isAbsolutePath(input.filePath)) {
    const relativePath = workspaceRelativeFilePath(input.filePath, input.workspaceRoot);
    const segments =
      relativePath === null ? null : normalizedRelativePathSegments(relativePath, windowsRoot);
    return segments ? segments.join("/") : null;
  }

  const fileSegments = normalizedRelativePathSegments(input.filePath, windowsRoot);
  if (!fileSegments) return null;

  const workspaceSegments = repositoryRelativeWorkspaceSegments(
    input.workspaceRoot,
    input.repositoryRoot,
  );
  if (!workspaceSegments) {
    // The repository can instead sit below the workspace, as with a clone inside a plain
    // project folder; its diff paths are still relative to the repository root.
    const repositorySegments = workspaceRelativeRepositorySegments(
      input.workspaceRoot,
      input.repositoryRoot,
    );
    return repositorySegments && repositorySegments.length > 0
      ? [...repositorySegments, ...fileSegments].join("/")
      : fileSegments.join("/");
  }
  if (workspaceSegments.length === 0) {
    return fileSegments.join("/");
  }

  const caseInsensitive = input.repositoryRoot
    ? isWindowsAbsolutePath(input.repositoryRoot)
    : false;
  const belongsToWorkspace = workspaceSegments.every((segment, index) => {
    const candidate = fileSegments[index];
    if (candidate === undefined) return false;
    return caseInsensitive
      ? candidate.toLowerCase() === segment.toLowerCase()
      : candidate === segment;
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
