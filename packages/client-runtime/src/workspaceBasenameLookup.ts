import { FILESYSTEM_METADATA_BATCH_LIMIT } from "@t3tools/contracts";
import {
  isAbsolutePath,
  isWindowsAbsolutePath,
  resolveWorkspaceFilePath,
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
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

const AGENT_DIRECTORY_SEARCH_LIMIT = 4;

/**
 * The file a bare name cites in the latest folder the agent worked in that has one of that name.
 * Folders are searched one at a time: the latest usually has it, and each search walks a tree.
 */
export async function findAgentDirectoryMatch(
  relativePath: string,
  directories: ReadonlyArray<string>,
  searchRoot: (root: string) => Promise<{
    readonly root: string;
    readonly entries: ReadonlyArray<WorkspaceEntryCandidate>;
  }>,
): Promise<string | null> {
  for (const directory of directories.slice(0, AGENT_DIRECTORY_SEARCH_LIMIT)) {
    const match = pickProjectLinkMatch(relativePath, [await searchRoot(directory)]);
    if (match !== null) return match;
  }
  return null;
}

// A quoted string or a comment is one token, so `cd` inside either is not read as a command.
const SHELL_TOKEN = /(?<![^\s;&|()])#[^\n]*|"[^"]*"|'[^']*'|[;&|()\n]|[ \t]+|[^\s;&|()"']+/g;
const SHELL_NAME = /(?:^|\/)(?:ba|z|da)?sh$/;
const CD_OPTION = /^-[LPe@]*$|^--$/;

/** The operands of the `cd` commands in `script`, in order, through `sh -c "<script>"`. */
function cdOperands(script: string): Array<string> {
  const operands: Array<string> = [];
  let words: Array<string> = [];
  let wordOpen = false;
  const endCommand = () => {
    const [name = "", ...rest] = words;
    if (name === "cd") {
      const operand = rest.find((word) => !CD_OPTION.test(word));
      if (operand !== undefined) operands.push(operand);
    } else if (SHELL_NAME.test(name)) {
      const inner = rest[rest.findIndex((word) => /^-[a-z]*c$/.test(word)) + 1];
      if (inner !== undefined && /^(["']).*\1$/s.test(inner)) {
        operands.push(...cdOperands(inner.slice(1, -1)));
      }
    }
    words = [];
    wordOpen = false;
  };
  for (const [token] of script.matchAll(SHELL_TOKEN)) {
    // A here-document's body is data, and where it ends is the shell's to say.
    if (!/^["'#]/.test(token) && token.includes("<<")) break;
    if (/^[;&|()\n]/.test(token)) endCommand();
    else if (/^[ \t]/.test(token) || (!wordOpen && token.startsWith("#"))) wordOpen = false;
    else if (wordOpen) words[words.length - 1] += token;
    else {
      words.push(token);
      wordOpen = true;
    }
  }
  endCommand();
  return operands;
}

function literalDirectory(operand: string): string | null {
  const path = /^["']/.test(operand) ? operand.slice(1, -1) : operand;
  // The shell would expand these, and only it knows to what.
  if (!isAbsolutePath(path) || /[$`*?[\]{}"']/.test(path)) return null;
  return path.includes("\\") && !isWindowsAbsolutePath(path) ? null : path;
}

interface TimelineItemSource {
  readonly sourceThreadId: string;
  readonly sourceItemId: string;
}

/**
 * The folders the commands above `reply` in a thread's timeline changed into, the latest first.
 * A reply cites paths relative to where the agent worked, which no project has to be rooted at.
 * Rows below the reply, a fork's own commands under an inherited one included, came after it.
 */
export function agentWorkingDirectories(
  items: ReadonlyArray<
    TimelineItemSource & { readonly item: { readonly type: string; readonly input?: unknown } }
  >,
  reply: TimelineItemSource,
): ReadonlyArray<string> {
  const directories = new Set<string>();
  const replyIndex = items.findIndex(
    (row) => row.sourceThreadId === reply.sourceThreadId && row.sourceItemId === reply.sourceItemId,
  );
  for (let index = replyIndex - 1; index >= 0; index--) {
    const item = items[index]?.item;
    if (item?.type !== "command_execution" || typeof item.input !== "string") continue;
    for (const operand of cdOperands(item.input).reverse()) {
      const directory = literalDirectory(operand);
      if (directory !== null) directories.add(directory);
      if (directories.size === FILESYSTEM_METADATA_BATCH_LIMIT) return [...directories];
    }
  }
  return [...directories];
}
