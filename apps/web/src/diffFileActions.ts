import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  isWindowsAbsolutePath,
  normalizeProjectPathForComparison,
  normalizeProjectPathForDispatch,
} from "@t3tools/shared/path";

import { useRightPanelStore } from "./rightPanelStore";
import { resolvePathLinkTarget } from "./terminal-links";

/**
 * Where the repository root a diff path is relative to came from.
 *
 * `configured` roots are built from the workspace root plus the segments of a
 * `t3.json` entry, so they always nest below the workspace. `detected` roots are
 * reported by git on the server and can disagree with the workspace root even
 * when both describe the same tree, because git resolves symlinks and the
 * workspace root does not.
 */
interface DiffRepositoryRoot {
  readonly path: string;
  readonly kind: "configured" | "detected";
}

interface OpenDiffFilePrimaryActionInput {
  readonly threadRef: ScopedThreadRef | null;
  readonly filePath: string;
  readonly activeCwd: string | undefined;
  readonly repositoryRoot?: DiffRepositoryRoot | undefined;
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

function pathSegments(value: string): ReadonlyArray<string> {
  return value.split(/[\\/]+/).filter(Boolean);
}

/**
 * Segments of `nestedPath` below `baseRoot`, `[]` when they are the same
 * directory, or `null` when `nestedPath` does not live below `baseRoot`.
 * Segments keep their original casing; comparison is case-insensitive on
 * Windows-style roots.
 */
function nestedPathSegments(
  baseRoot: string | undefined,
  nestedPath: string | undefined,
): ReadonlyArray<string> | null {
  if (!baseRoot || !nestedPath) return null;

  const dispatchNestedPath = normalizeProjectPathForDispatch(nestedPath);
  const normalizedBaseRoot = normalizeProjectPathForComparison(baseRoot);
  const normalizedNestedPath = normalizeProjectPathForComparison(dispatchNestedPath);
  if (normalizedBaseRoot === normalizedNestedPath) return [];

  const separator = normalizedBaseRoot.includes("\\") ? "\\" : "/";
  const basePrefix = normalizedBaseRoot.endsWith(separator)
    ? normalizedBaseRoot
    : `${normalizedBaseRoot}${separator}`;
  if (!normalizedNestedPath.startsWith(basePrefix)) return null;

  // Drop as many leading segments as the base root has rather than slicing by
  // the matched prefix length: comparison normalization lowercases Windows
  // paths, and Unicode lowercasing can change a string's length, so a length
  // measured on the comparison form does not carry over to the original casing.
  return pathSegments(dispatchNestedPath).slice(pathSegments(normalizedBaseRoot).length);
}

/**
 * Resolves a repository path configured in `t3.json` against the workspace root.
 *
 * Configuration paths are strictly workspace-relative: unlike a terminal link
 * there is no `~` expansion and no `:line:column` suffix, and anything that
 * could escape the workspace yields `null` so callers can refuse the path
 * instead of silently reading a different tree.
 */
export function resolveConfiguredRepositoryRoot(
  repositoryPath: string,
  workspaceRoot: string,
): string | null {
  const trimmed = repositoryPath.trim();
  if (trimmed === ".") return workspaceRoot;
  if (trimmed.startsWith("/") || trimmed.startsWith("\\")) return null;
  // `isWindowsAbsolutePath` covers UNC and `C:/`, but not drive-relative `C:foo`.
  if (isWindowsAbsolutePath(trimmed) || /^[a-zA-Z]:/.test(trimmed)) return null;

  const segments = trimmed
    .replaceAll("\\", "/")
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== ".");
  if (segments.length === 0) return null;
  const escapesWorkspace = segments.some(
    (segment) => segment === ".." || segment.startsWith("~") || segment.includes(":"),
  );
  if (escapesWorkspace) return null;

  const separator = isWindowsAbsolutePath(workspaceRoot) ? "\\" : "/";
  const base = normalizeProjectPathForDispatch(workspaceRoot);
  const joined = segments.join(separator);
  return base.endsWith("/") || base.endsWith("\\")
    ? `${base}${joined}`
    : `${base}${separator}${joined}`;
}

export function resolveDiffPathForWorkspace(input: {
  readonly filePath: string;
  readonly workspaceRoot: string | undefined;
  readonly repositoryRoot: DiffRepositoryRoot | undefined;
}): string | null {
  const fileSegments = normalizedRelativePathSegments(input.filePath);
  if (!fileSegments) return null;

  // Without a repository root the diff path is workspace-relative by definition.
  const repositoryRoot = input.repositoryRoot?.path;
  if (!repositoryRoot) {
    return fileSegments.join("/");
  }

  // Otherwise the diff path is relative to the repository while callers resolve
  // against the workspace, so the two roots have to be reconciled: the workspace
  // can sit below the repository (strip the shared prefix) or the repository can
  // sit below the workspace (prepend its offset).
  const workspaceSegments = nestedPathSegments(repositoryRoot, input.workspaceRoot);
  if (workspaceSegments === null) {
    const repositorySegments = nestedPathSegments(input.workspaceRoot, repositoryRoot);
    if (repositorySegments !== null) {
      return [...repositorySegments, ...fileSegments].join("/");
    }
    // Roots that do not nest either way mean different things per origin. A
    // configured root is built from the workspace root, so this is unreachable
    // by construction and a mismatch means the input is not what we think it is
    // — refuse rather than open a same-named file in an unrelated tree. A
    // detected root routinely differs from the workspace root for the same tree
    // (git resolves symlinks, the workspace root does not), so the diff path is
    // still the best relative path we have.
    return input.repositoryRoot.kind === "configured" ? null : fileSegments.join("/");
  }
  if (workspaceSegments.length === 0) {
    return fileSegments.join("/");
  }

  const caseInsensitive = isWindowsAbsolutePath(repositoryRoot);
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
