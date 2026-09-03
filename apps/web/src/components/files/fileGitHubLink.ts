import type { ContextMenuItem, RepositoryIdentity, VcsRef } from "@t3tools/contracts";
import {
  isWindowsAbsolutePath,
  normalizeProjectPathForComparison,
  normalizeProjectPathForDispatch,
} from "@t3tools/shared/path";
import { detectSourceControlProviderFromRemoteUrl } from "@t3tools/shared/sourceControl";

export type FileLineContextMenuAction = "copy-github-link";
type GitHubRemoteRef = Pick<VcsRef, "name" | "isRemote" | "remoteName">;

export const FILE_LINE_CONTEXT_MENU_ITEMS = [
  {
    id: "copy-github-link",
    label: "Copy GitHub link",
    icon: "github",
    accelerator: "CmdOrCtrl+Shift+C",
  },
] as const satisfies readonly ContextMenuItem<FileLineContextMenuAction>[];

function parseLineNumber(value: string | null): number | null {
  if (value === null || !/^[1-9]\d*$/u.test(value)) return null;
  const line = Number(value);
  return Number.isSafeInteger(line) ? line : null;
}

/** Context-menu events are composed, so their path retains Pierre's shadow-DOM line elements. */
export function fileLineNumberFromComposedPath(path: ReadonlyArray<EventTarget>): number | null {
  for (const target of path) {
    if (!(target instanceof Element)) continue;
    const line =
      parseLineNumber(target.getAttribute("data-line")) ??
      parseLineNumber(target.getAttribute("data-column-number"));
    if (line !== null) return line;
  }
  return null;
}

function relativePathSegments(value: string): ReadonlyArray<string> | null {
  if (value.startsWith("/") || isWindowsAbsolutePath(value) || /^[a-zA-Z]:/u.test(value)) {
    return null;
  }
  const segments = value
    .replaceAll("\\", "/")
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== ".");
  if (segments.length === 0 || segments.includes("..")) return null;
  return segments;
}

function workspacePathSegments(
  workspaceRoot: string,
  repositoryRoot: string | undefined,
): ReadonlyArray<string> | null {
  if (!repositoryRoot) return [];

  const workspacePath = normalizeProjectPathForDispatch(workspaceRoot).replaceAll("\\", "/");
  const repositoryPath = normalizeProjectPathForDispatch(repositoryRoot).replaceAll("\\", "/");
  const comparableWorkspacePath = normalizeProjectPathForComparison(workspaceRoot).replaceAll(
    "\\",
    "/",
  );
  const comparableRepositoryPath = normalizeProjectPathForComparison(repositoryRoot).replaceAll(
    "\\",
    "/",
  );
  if (comparableWorkspacePath === comparableRepositoryPath) return [];

  const repositoryPrefix = repositoryPath.endsWith("/") ? repositoryPath : `${repositoryPath}/`;
  const comparableRepositoryPrefix = comparableRepositoryPath.endsWith("/")
    ? comparableRepositoryPath
    : `${comparableRepositoryPath}/`;
  if (!comparableWorkspacePath.startsWith(comparableRepositoryPrefix)) return null;

  return workspacePath.slice(repositoryPrefix.length).split("/").filter(Boolean);
}

function repositoryCoordinates(
  identity: RepositoryIdentity,
): { readonly owner: string; readonly name: string } | null {
  const owner = identity.owner?.trim();
  const name = identity.name?.trim();
  if (!owner || !name) return null;
  return { owner, name };
}

function repositoryOrigin(identity: RepositoryIdentity): URL | null {
  const provider = detectSourceControlProviderFromRemoteUrl(identity.locator.remoteUrl);
  if (provider?.kind !== "github") return null;
  try {
    return new URL(provider.baseUrl);
  } catch {
    return null;
  }
}

function isGitHubRefPublished(
  identity: RepositoryIdentity | null | undefined,
  refName: string | null | undefined,
  refs: ReadonlyArray<GitHubRemoteRef> | undefined,
): boolean {
  const normalizedRefName = refName?.trim();
  if (identity?.provider !== "github" || !normalizedRefName) return false;

  const remoteName = identity.locator.remoteName;
  return (
    refs?.some(
      (ref) =>
        ref.isRemote === true &&
        ref.remoteName === remoteName &&
        ref.name === `${remoteName}/${normalizedRefName}`,
    ) === true
  );
}

export function buildGitHubFileLineUrl(input: {
  readonly identity: RepositoryIdentity | null | undefined;
  readonly refName: string | null | undefined;
  readonly relativePath: string;
  readonly workspaceRoot: string;
  /** Omit for a separate worktree, whose path is unrelated to the project's original Git root. */
  readonly repositoryRoot?: string | undefined;
  readonly remoteRefs: ReadonlyArray<GitHubRemoteRef> | undefined;
  readonly line: number;
}): string | null {
  const identity = input.identity;
  const refName = input.refName?.trim();
  if (
    identity?.provider !== "github" ||
    !refName ||
    !isGitHubRefPublished(identity, refName, input.remoteRefs) ||
    !Number.isSafeInteger(input.line) ||
    input.line < 1
  ) {
    return null;
  }

  const repository = repositoryCoordinates(identity);
  const origin = repositoryOrigin(identity);
  const fileSegments = relativePathSegments(input.relativePath);
  const workspaceSegments = workspacePathSegments(input.workspaceRoot, input.repositoryRoot);
  if (!repository || !origin || !fileSegments || !workspaceSegments) return null;

  const pathSegments = [
    repository.owner,
    repository.name,
    "blob",
    ...refName.split("/"),
    ...workspaceSegments,
    ...fileSegments,
  ];
  if (pathSegments.some((segment) => segment.length === 0)) return null;

  origin.pathname = `/${pathSegments.map(encodeURIComponent).join("/")}`;
  origin.hash = `L${input.line}`;
  return origin.toString();
}
