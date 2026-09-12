import { buildRemoteOpenUrl, type EditorId, type ScopedThreadRef } from "@t3tools/contracts";
import { isWindowsAbsolutePath, normalizeProjectPathForComparison } from "@t3tools/shared/path";

import type { RemoteOpenState } from "./remoteOpen";
import { useRightPanelStore } from "./rightPanelStore";
import { resolvePathLinkTarget } from "./terminal-links";

interface OpenDiffFilePrimaryActionInput {
  readonly threadRef: ScopedThreadRef | null;
  readonly filePath: string;
  readonly activeCwd: string | undefined;
  readonly repositoryRoot?: string | undefined;
  readonly openInEditor: (targetPath: string) => void;
}

function normalizedRelativePathSegments(filePath: string): ReadonlyArray<string> | null {
  if (filePath.startsWith("/") || isWindowsAbsolutePath(filePath) || /^[a-zA-Z]:/.test(filePath)) {
    return null;
  }

  const segments = filePath
    .replaceAll("\\", "/")
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== ".");
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
  const fileSegments = normalizedRelativePathSegments(input.filePath);
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

interface DiffFileTarget {
  readonly workspaceFilePath: string;
  readonly editorTargetPath: string;
}

/** Resolves a repo-relative diff path to the active workspace: null when it lies outside it. */
function resolveDiffFileTarget(input: {
  readonly filePath: string;
  readonly activeCwd: string | undefined;
  readonly repositoryRoot?: string | undefined;
}): DiffFileTarget | null {
  const workspaceFilePath = resolveDiffPathForWorkspace({
    filePath: input.filePath,
    workspaceRoot: input.activeCwd,
    repositoryRoot: input.repositoryRoot,
  });
  if (!workspaceFilePath) return null;
  return {
    workspaceFilePath,
    editorTargetPath: input.activeCwd
      ? resolvePathLinkTarget(workspaceFilePath, input.activeCwd)
      : workspaceFilePath,
  };
}

export function openDiffFileInEditor(
  input: Omit<OpenDiffFilePrimaryActionInput, "threadRef">,
): void {
  const target = resolveDiffFileTarget(input);
  if (target) input.openInEditor(target.editorTargetPath);
}

export function openDiffFilePrimaryAction(input: OpenDiffFilePrimaryActionInput): void {
  const target = resolveDiffFileTarget(input);
  if (!target) return;

  if (input.threadRef) {
    useRightPanelStore.getState().openFile(input.threadRef, target.workspaceFilePath);
    return;
  }

  input.openInEditor(target.editorTargetPath);
}

export type DiffEditorLaunch =
  | { readonly kind: "unavailable" }
  | { readonly kind: "remote-url"; readonly url: string }
  | { readonly kind: "local-exec"; readonly editor: EditorId; readonly reveal: boolean };

/**
 * Picks how a diff file reaches the user's editor. A client on another machine
 * gets an SSH deep link; with no SSH route the action is unavailable, since a
 * server-side exec would open the file where the user cannot see it.
 */
export function resolveDiffEditorLaunch(input: {
  readonly remoteOpen: RemoteOpenState;
  readonly editor: EditorId | null;
  readonly targetPath: string;
  readonly revealInFileManager: boolean;
}): DiffEditorLaunch {
  const { remoteOpen, editor } = input;
  if (editor === null || remoteOpen.mode === "remote-unavailable") return { kind: "unavailable" };
  if (remoteOpen.mode === "remote-links") {
    const url = buildRemoteOpenUrl({
      editor,
      host: remoteOpen.host.host,
      absolutePath: input.targetPath,
    });
    return url === undefined ? { kind: "unavailable" } : { kind: "remote-url", url };
  }
  return {
    kind: "local-exec",
    editor,
    reveal: input.revealInFileManager && editor === "file-manager",
  };
}
