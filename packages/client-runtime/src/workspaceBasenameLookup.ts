import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import {
  isAbsolutePath,
  isWindowsAbsolutePath,
  resolveWorkspaceFilePath,
  workspaceRelativeFilePath,
} from "@t3tools/shared/path";

export const WORKSPACE_BASENAME_LOOKUP_LIMIT = 25;

// All callers open one panel; the newest click must win across callers.
let latestLookupSequence = 0;

export function claimWorkspaceBasenameLookup(): () => boolean {
  latestLookupSequence += 1;
  const claimed = latestLookupSequence;
  return () => claimed === latestLookupSequence;
}

export interface WorkspaceEntryCandidate {
  readonly path: string;
  readonly kind: "file" | "directory";
}

function basenameOfPath(path: string): string {
  const separatorIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return separatorIndex >= 0 ? path.slice(separatorIndex + 1) : path;
}

export function needsWorkspaceBasenameLookup(relativePath: string): boolean {
  const trimmed = relativePath.trim();
  return (
    trimmed !== "." &&
    trimmed !== ".." &&
    trimmed.length > 0 &&
    !trimmed.includes("/") &&
    !trimmed.includes("\\")
  );
}

export function pickWorkspaceBasenameMatch(
  basename: string,
  entries: ReadonlyArray<WorkspaceEntryCandidate>,
): string | null {
  const target = basename.trim();
  if (!target) return null;
  const files = entries.filter((entry) => entry.kind === "file");
  const exact = files.find((entry) => basenameOfPath(entry.path) === target);
  if (exact) return exact.path;
  const folded = target.toLowerCase();
  const foldedMatches = files.filter(
    (entry) => basenameOfPath(entry.path).toLowerCase() === folded,
  );
  return foldedMatches.length === 1 ? (foldedMatches[0]?.path ?? null) : null;
}

// Repository-relative paths can repeat the project's suffix in subfolder projects.
function stripRepeatedWorkspacePrefix(relativePath: string, cwd: string): string | null {
  if (isAbsolutePath(relativePath)) return null;
  const pathSegments = relativePath.split(/[\\/]+/);
  const cwdSegments = cwd.split(/[\\/]+/).filter(Boolean);
  const fold = isWindowsAbsolutePath(cwd)
    ? (segment: string | undefined) => segment?.toLowerCase()
    : (segment: string | undefined) => segment;
  for (let count = Math.min(cwdSegments.length, pathSegments.length - 1); count > 0; count--) {
    const prefix = cwdSegments.slice(-count);
    if (prefix.every((segment, index) => fold(segment) === fold(pathSegments[index]))) {
      return pathSegments.slice(count).join("/") || null;
    }
  }
  return null;
}

/**
 * The project search query that may find a chat file link's real file, or null when the link
 * names its file exactly. Agents often cite paths relative to a package (`cloud/http.ts`).
 */
export function workspaceLinkLookupQuery(relativePath: string, cwd: string): string | null {
  const trimmed = relativePath.trim();
  if (isAbsolutePath(trimmed) || /^(?:\.{1,2}|~)[\\/]/.test(trimmed) || /[\\/]$/.test(trimmed)) {
    return null;
  }
  if (needsWorkspaceBasenameLookup(trimmed)) return trimmed;
  return stripRepeatedWorkspacePrefix(trimmed, cwd) ?? trimmed;
}

/** The one file a chat link names: its basename, its path past a repeated prefix, or its suffix. */
export function pickWorkspaceLinkMatch(
  relativePath: string,
  cwd: string,
  entries: ReadonlyArray<WorkspaceEntryCandidate>,
): string | null {
  const trimmed = relativePath.trim();
  if (needsWorkspaceBasenameLookup(trimmed)) return pickWorkspaceBasenameMatch(trimmed, entries);
  const stripped = stripRepeatedWorkspacePrefix(trimmed, cwd);
  const strippedMatch =
    stripped === null ? null : pickStrippedWorkspaceMatch(stripped, cwd, entries);
  if (strippedMatch !== null) return strippedMatch;
  const suffix = trimmed.replaceAll("\\", "/");
  const matches = entries.filter(
    (entry) =>
      entry.kind === "file" &&
      (entry.path.replaceAll("\\", "/") === suffix ||
        entry.path.replaceAll("\\", "/").endsWith(`/${suffix}`)),
  );
  return matches.length === 1 ? (matches[0]?.path ?? null) : null;
}

function pickStrippedWorkspaceMatch(
  strippedPath: string,
  cwd: string,
  entries: ReadonlyArray<WorkspaceEntryCandidate>,
): string | null {
  const caseInsensitive = isWindowsAbsolutePath(cwd);
  const key = (path: string) => {
    const normalized = path.replaceAll("\\", "/");
    return caseInsensitive ? normalized.toLowerCase() : normalized;
  };
  const files = entries.filter((entry) => entry.kind === "file");
  return files.find((entry) => key(entry.path) === key(strippedPath))?.path ?? null;
}

/**
 * The absolute path of the one file a chat link names across other project roots, or null when
 * no root or more than one has it. Agents cite paths relative to whichever repo they worked in.
 */
export function pickProjectLinkMatch(
  relativePath: string,
  searches: ReadonlyArray<{
    readonly root: string;
    readonly entries: ReadonlyArray<WorkspaceEntryCandidate>;
  }>,
): string | null {
  const matches = searches.flatMap(({ root, entries }) => {
    const match = pickWorkspaceLinkMatch(relativePath, root, entries);
    return match === null ? [] : [resolveWorkspaceFilePath(match, root)];
  });
  return new Set(matches).size === 1 ? (matches[0] ?? null) : null;
}

// Only a `cd` that opens the command, optionally inside Codex's `sh -lc` wrapper: a `cd` inside an
// argument (`printf 'cd /x'`) changes nothing. Anchored and without overlapping quantifiers.
const COMMAND_CD_PATTERN =
  /^\s*(?:(?:\S*\/)?(?:ba|z|da|k)?sh\s+-l?c\s+["'])?cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|()'"]+))/;

function commandDirectory(input: string): string | null {
  const match = COMMAND_CD_PATTERN.exec(input);
  if (match === null) return null;
  let index = match[0].length;
  while (input[index] === " " || input[index] === "\t") index += 1;
  const next = input[index];
  // A separator, the end, or the wrapper's closing quote must follow for `cd` to be a whole command.
  const wholeCommand =
    next === undefined ||
    next === "\n" ||
    next === ";" ||
    input.startsWith("&&", index) ||
    ((next === "'" || next === '"') && input.slice(index + 1).trim() === "");
  if (!wholeCommand) return null;
  const directory = match[1] ?? match[2] ?? match[3] ?? "";
  let end = directory.length;
  while (end > 1 && (directory[end - 1] === "/" || directory[end - 1] === "\\")) end -= 1;
  const trimmed = directory.slice(0, end);
  // Path helpers trim separator runs with regexes that are quadratic on a long inner run.
  return /[\\/]{2}/.test(trimmed) ? null : trimmed;
}

/**
 * Absolute directories that commands before `beforeOrdinal` `cd` into outside `cwd`, where a
 * message at that position may point. Later commands cannot have informed it.
 */
export function threadCommandDirectories(
  items: ReadonlyArray<OrchestrationV2TurnItem>,
  cwd: string,
  beforeOrdinal: number,
): string[] {
  const directories = new Set<string>();
  for (const item of items) {
    if (item.type !== "command_execution" || item.ordinal >= beforeOrdinal) continue;
    const directory = commandDirectory(item.input);
    // Searching an ancestor of the workspace (`cd ~`, `cd /`) would crawl far past the checkout.
    if (
      directory !== null &&
      isAbsolutePath(directory) &&
      workspaceRelativeFilePath(directory, cwd) === null &&
      workspaceRelativeFilePath(cwd, directory) === null
    ) {
      directories.add(directory);
    }
  }
  return [...directories];
}
