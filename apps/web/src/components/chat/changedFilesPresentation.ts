import { type TurnDiffFileChange } from "../../types";
import { summarizeTurnDiffStats } from "../../lib/turnDiffTree";
import { buildRepoRootLabels } from "../../lib/repoRootLabels";

export const CHANGED_FILES_AUTO_EXPAND_FILE_LIMIT = 5;
export const CHANGED_FILES_AUTO_EXPAND_LINE_LIMIT = 200;
export const CHANGED_FILES_PREVIEW_FILE_LIMIT = 3;
export const CHANGED_FILES_PREVIEW_SCOPE_LIMIT = 4;

export interface ChangedFilesScopeSummary {
  readonly label: string;
  readonly fileCount: number;
}

function pathSegments(pathValue: string): string[] {
  return pathValue
    .replaceAll("\\", "/")
    .split("/")
    .filter((segment) => segment.length > 0);
}

export function changedFileName(pathValue: string): string {
  return pathSegments(pathValue).at(-1) ?? pathValue;
}

function changedFilePathScope(file: TurnDiffFileChange): string {
  const segments = pathSegments(file.path);
  return segments.length > 1 ? (segments[0] ?? "root") : "root";
}

function changedFileScopeId(file: TurnDiffFileChange): string {
  return file.repoRoot ? `repo\0${file.repoRoot}` : `path\0${changedFilePathScope(file)}`;
}

export function shouldAutoExpandChangedFiles(
  files: ReadonlyArray<TurnDiffFileChange>,
  isLatestTurn: boolean,
): boolean {
  if (!isLatestTurn || files.length > CHANGED_FILES_AUTO_EXPAND_FILE_LIMIT) {
    return false;
  }
  const stat = summarizeTurnDiffStats(files);
  return stat.additions + stat.deletions <= CHANGED_FILES_AUTO_EXPAND_LINE_LIMIT;
}

export function summarizeChangedFileScopes(
  files: ReadonlyArray<TurnDiffFileChange>,
  limit = CHANGED_FILES_PREVIEW_SCOPE_LIMIT,
): ChangedFilesScopeSummary[] {
  const rootLabels = buildRepoRootLabels(
    files.flatMap((file) => (file.repoRoot ? [file.repoRoot] : [])),
  );
  const scopes = new Map<string, { fileCount: number; firstIndex: number; label: string }>();
  files.forEach((file, index) => {
    const id = changedFileScopeId(file);
    const current = scopes.get(id);
    scopes.set(id, {
      fileCount: (current?.fileCount ?? 0) + 1,
      firstIndex: current?.firstIndex ?? index,
      label: file.repoRoot
        ? (rootLabels.get(file.repoRoot) ?? file.repoRoot)
        : changedFilePathScope(file),
    });
  });

  return Array.from(scopes.values(), (scope) => ({
    label: scope.label,
    fileCount: scope.fileCount,
    firstIndex: scope.firstIndex,
  }))
    .toSorted(
      (left, right) =>
        right.fileCount - left.fileCount ||
        left.firstIndex - right.firstIndex ||
        left.label.localeCompare(right.label),
    )
    .slice(0, limit)
    .map(({ label, fileCount }) => ({ label, fileCount }));
}

export function selectChangedFilePreview(
  files: ReadonlyArray<TurnDiffFileChange>,
  limit = CHANGED_FILES_PREVIEW_FILE_LIMIT,
): TurnDiffFileChange[] {
  const selected: TurnDiffFileChange[] = [];
  const selectedPaths = new Set<string>();
  const selectedScopes = new Set<string>();

  for (const file of files) {
    const scope = changedFileScopeId(file);
    if (selectedScopes.has(scope)) {
      continue;
    }
    selected.push(file);
    selectedPaths.add(`${file.repoRoot ?? ""}\0${file.path}`);
    selectedScopes.add(scope);
    if (selected.length === limit) {
      return selected;
    }
  }

  for (const file of files) {
    if (selectedPaths.has(`${file.repoRoot ?? ""}\0${file.path}`)) {
      continue;
    }
    selected.push(file);
    if (selected.length === limit) {
      break;
    }
  }

  return selected;
}
