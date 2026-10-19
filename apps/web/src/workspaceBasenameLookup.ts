import { isAbsolutePath } from "@t3tools/shared/path";

export const WORKSPACE_BASENAME_LOOKUP_LIMIT = 25;

// Claims span markdown messages in a thread and expire when the action settles.
const pendingActions = new Map<string, symbol>();

export async function runWorkspaceFileAction<A>(
  scope: string | undefined,
  action: (isCurrent: () => boolean) => A | Promise<A>,
): Promise<A> {
  if (scope === undefined) return action(() => true);
  const token = Symbol();
  pendingActions.set(scope, token);
  const isCurrent = () => pendingActions.get(scope) === token;
  try {
    return await action(isCurrent);
  } finally {
    if (isCurrent()) pendingActions.delete(scope);
  }
}

export interface WorkspaceEntryCandidate {
  readonly path: string;
  readonly kind: "file" | "directory";
}

export function normalizeWorkspaceLookupPath(relativePath: string): string {
  const normalized = relativePath
    .trim()
    .replaceAll("\\", "/")
    .replace(/^(?:\.\/)+/, "");
  if (
    isAbsolutePath(normalized) ||
    /^(?:[a-z]:|~\/)/i.test(normalized) ||
    normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    return "";
  }
  return normalized;
}

export function pickWorkspaceBasenameMatch(
  relativePath: string,
  entries: ReadonlyArray<WorkspaceEntryCandidate>,
): string | null {
  const target = normalizeWorkspaceLookupPath(relativePath);
  if (!target) return null;
  const files = entries.filter((entry) => entry.kind === "file");
  const pathOf = (entry: WorkspaceEntryCandidate) => entry.path.replaceAll("\\", "/");
  const hasSuffix = (path: string, suffix: string) =>
    path === suffix || path.endsWith(`/${suffix}`);
  const slashed = target.includes("/");
  const exactPath = slashed ? files.find((entry) => pathOf(entry) === target) : undefined;
  if (exactPath) return exactPath.path;
  const matches = files.filter((entry) => hasSuffix(pathOf(entry), target));
  if (matches.length > 0) {
    return !slashed || matches.length === 1 ? (matches[0]?.path ?? null) : null;
  }
  const foldedTarget = target.toLowerCase();
  const foldedMatches = files.filter((entry) =>
    hasSuffix(pathOf(entry).toLowerCase(), foldedTarget),
  );
  return foldedMatches.length === 1 ? (foldedMatches[0]?.path ?? null) : null;
}
