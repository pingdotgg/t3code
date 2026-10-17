import type { OrchestrationV2TurnItem } from "@t3tools/contracts";

import { isAbsolutePath, isWindowsAbsolutePath, workspaceRelativeFilePath } from "./path.ts";

/**
 * Absolute paths a thread's own tool activity named: files it changed, read,
 * viewed or found, and the paths in the commands it ran. An agent that names a
 * file relative to wherever it was working (`references/notes.md`) usually
 * touched that file, or the folder holding it, earlier in the thread, so these
 * paths suggest which file a relative reference means without asking the
 * filesystem. Callers still confirm the suggestion exists before using it.
 */
export interface ThreadFilePathIndex {
  /** Comparison key (forward slashes, Windows paths folded) to the path as reported. */
  readonly pathsByKey: ReadonlyMap<string, string>;
  /** Folded final segment to the named paths ending in it. */
  readonly pathsByName: ReadonlyMap<string, ReadonlyArray<string>>;
  /** Comparison keys of every named path and its parent, as folders. */
  readonly directoryKeys: ReadonlySet<string>;
  /** Folded final segment to the folders ending in it. */
  readonly directoriesByName: ReadonlyMap<string, ReadonlyArray<string>>;
}

// Field names the Claude adapter already reads a tool's target path from.
const TOOL_INPUT_PATH_FIELDS = ["file_path", "notebook_path", "path", "filename", "fileName"];

// An absolute POSIX or drive-letter path starting a shell word or a quoted string.
const COMMAND_ABSOLUTE_PATH_PATTERN = /(?:^|[\s"'=(])((?:\/|[A-Za-z]:[\\/])[^\s"'`;|&<>()$*?]+)/g;

// A plain relative operand: no flag, assignment, glob or variable. Spaces survive
// only inside quotes, since unquoted words are already split on them.
const RELATIVE_OPERAND_PATTERN = /^[\w.@+][\w./@+ -]*$/;

// Separators after which a `cd` still governs the next command. A `cd` in a
// pipeline or a background job runs in a subshell, and `||` runs only if it failed.
const DIRECTORY_KEEPING_SEPARATORS = new Set([";", "&&", "\n"]);
const COMMAND_SEPARATORS = new Set([";", "&&", "||", "|", "&", "\n"]);

function comparisonKey(path: string): string {
  const forward = path.replaceAll("\\", "/").replaceAll("/./", "/").replace(/\/+$/, "");
  return isWindowsAbsolutePath(path) ? forward.toLowerCase() : forward;
}

function lastSegment(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  return trimmed.slice(Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\")) + 1);
}

function parentPath(path: string): string | null {
  const trimmed = path.replace(/[\\/]+$/, "");
  const separatorIndex = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return separatorIndex > 0 ? trimmed.slice(0, separatorIndex) : null;
}

function toolInputPaths(input: unknown): string[] {
  if (typeof input !== "object" || input === null) return [];
  const record = input as Record<string, unknown>;
  return TOOL_INPUT_PATH_FIELDS.flatMap((field) => {
    const value = record[field];
    return typeof value === "string" ? [value] : [];
  });
}

/** Words and separators, keeping a quoted path whole. Enough to follow `cd`, not a shell parser. */
function shellTokens(command: string): string[] {
  const tokens: string[] = [];
  let word = "";
  let inWord = false;
  let quote: string | null = null;
  const flush = () => {
    if (inWord) tokens.push(word);
    word = "";
    inWord = false;
  };
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (quote !== null) {
      if (character === quote) quote = null;
      else word += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      inWord = true;
    } else if (character === "\n" || character === ";" || character === "|" || character === "&") {
      flush();
      const pair = command.slice(index, index + 2);
      if (pair === "&&" || pair === "||") {
        tokens.push(pair);
        index += 1;
      } else {
        tokens.push(character);
      }
    } else if (/\s/u.test(character)) {
      flush();
    } else {
      word += character;
      inWord = true;
    }
  }
  flush();
  return tokens;
}

function joinPosixPath(base: string, relative: string): string {
  const segments = base.split("/").filter(Boolean);
  for (const segment of relative.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return `/${segments.join("/")}`;
}

/**
 * Absolute paths in a command, plus its relative operands read against the
 * folder they ran in: the thread's root, or a `cd` earlier in the same
 * command. A provider's shell does not keep a `cd` that leaves the workspace
 * between commands, so this follows only what the command itself says.
 */
function commandPaths(command: string, workspaceRoot: string | null): string[] {
  const paths = [...command.matchAll(COMMAND_ABSOLUTE_PATH_PATTERN)].map((match) =>
    (match[1] ?? "").replace(/[.,:]+$/, ""),
  );
  let base = workspaceRoot?.startsWith("/") ? joinPosixPath("/", workspaceRoot) : null;
  let words: string[] = [];
  const finishCommand = (separator: string | null) => {
    const [name, ...operands] = words;
    words = [];
    if (name === "cd" || name === "pushd" || name === "popd") {
      if (separator !== null && !DIRECTORY_KEEPING_SEPARATORS.has(separator)) return;
      const target = name === "popd" ? undefined : operands.find((word) => !word.startsWith("-"));
      base =
        target === undefined
          ? null
          : target.startsWith("/")
            ? joinPosixPath("/", target)
            : base !== null && RELATIVE_OPERAND_PATTERN.test(target)
              ? joinPosixPath(base, target)
              : null;
      if (base !== null) paths.push(base);
      return;
    }
    for (const operand of operands) {
      // `--output=/x/y` and `>/x/y` name a path after their prefix.
      const word = operand.replace(/^(?:--?[\w-]+=|\d*[<>]+&?)/, "");
      if (word.startsWith("/")) paths.push(joinPosixPath("/", word));
      else if (base !== null && RELATIVE_OPERAND_PATTERN.test(word)) {
        paths.push(joinPosixPath(base, word));
      }
    }
  };
  for (const token of shellTokens(command)) {
    if (COMMAND_SEPARATORS.has(token)) finishCommand(token);
    else words.push(token);
  }
  finishCommand(null);
  return paths;
}

function turnItemPaths(item: OrchestrationV2TurnItem, workspaceRoot: string | null): string[] {
  switch (item.type) {
    case "file_change":
      return [item.fileName, ...(item.changes ?? []).map((change) => change.path)];
    case "dynamic_tool":
      return [
        ...(item.viewedImagePath === undefined ? [] : [item.viewedImagePath]),
        ...toolInputPaths(item.input),
      ];
    case "file_search":
      return (item.results ?? []).map((result) => result.fileName);
    case "command_execution":
      return commandPaths(item.input, workspaceRoot);
    default:
      return [];
  }
}

// Turn items are immutable and stay referentially stable across projection
// updates, so each one is scanned once per workspace root.
const pathsByItem = new WeakMap<
  OrchestrationV2TurnItem,
  { readonly workspaceRoot: string | null; readonly paths: ReadonlyArray<string> }
>();

export function threadFilePaths(
  items: ReadonlyArray<OrchestrationV2TurnItem>,
  workspaceRoot: string | null = null,
): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const item of items) {
    let cached = pathsByItem.get(item);
    if (cached === undefined || cached.workspaceRoot !== workspaceRoot) {
      cached = {
        workspaceRoot,
        paths: turnItemPaths(item, workspaceRoot)
          .map((path) => path.trim())
          .filter(isAbsolutePath),
      };
      pathsByItem.set(item, cached);
    }
    for (const path of cached.paths) {
      if (seen.has(path)) continue;
      seen.add(path);
      paths.push(path);
    }
  }
  return paths;
}

function addByName(map: Map<string, string[]>, path: string) {
  const name = lastSegment(path).toLowerCase();
  const paths = map.get(name);
  if (paths) paths.push(path);
  else map.set(name, [path]);
}

export function buildThreadFilePathIndex(paths: Iterable<string>): ThreadFilePathIndex {
  const pathsByKey = new Map<string, string>();
  const pathsByName = new Map<string, string[]>();
  const directoryKeys = new Set<string>();
  const directoriesByName = new Map<string, string[]>();
  for (const path of paths) {
    const key = comparisonKey(path);
    if (pathsByKey.has(key)) continue;
    pathsByKey.set(key, path);
    addByName(pathsByName, path);
    for (const directory of [path, parentPath(path)]) {
      if (directory === null) continue;
      const directoryKey = comparisonKey(directory);
      if (directoryKeys.has(directoryKey)) continue;
      directoryKeys.add(directoryKey);
      addByName(directoriesByName, directory);
    }
  }
  return { pathsByKey, pathsByName, directoryKeys, directoriesByName };
}

function endingWith(paths: ReadonlyArray<string> | undefined, suffix: string): string[] {
  const foldedSuffix = suffix.toLowerCase();
  return (paths ?? []).filter((path) =>
    isWindowsAbsolutePath(path)
      ? comparisonKey(path).endsWith(foldedSuffix)
      : comparisonKey(path).endsWith(suffix),
  );
}

/**
 * The thread path a relative file reference may mean, or null to keep joining
 * it onto the workspace root. A reference needs a directory segment, because a
 * bare `index.ts` is too common a name to bind to whichever one the agent
 * touched. The root-joined path wins when the thread touched it, and several
 * matches resolve to nothing rather than to a guess.
 *
 * A path the thread named that ends with the reference comes first. Failing
 * that, a folder the thread named that ends with the reference's folder holds
 * it, as when an agent listed `raw/` and then names `raw/recording.mp3`. That
 * second rule only looks outside the workspace: inside it, a monorepo's many
 * `src/` folders would outvote the root file the reference usually means.
 */
export function matchThreadFilePath(
  relativePath: string,
  rootJoinedPath: string | null,
  workspaceRoot: string | null,
  index: ThreadFilePathIndex,
): string | null {
  const reference = relativePath
    .replaceAll("\\", "/")
    .replace(/^(?:\.\/)+/, "")
    .replace(/\/+$/, "");
  if (reference.startsWith("../") || reference.startsWith("~") || !reference.includes("/")) {
    return null;
  }
  if (rootJoinedPath !== null && index.pathsByKey.has(comparisonKey(rootJoinedPath))) {
    return null;
  }

  const separatorIndex = reference.lastIndexOf("/");
  const name = reference.slice(separatorIndex + 1);
  const namedPaths = endingWith(index.pathsByName.get(name.toLowerCase()), `/${reference}`);
  if (namedPaths.length > 0) return namedPaths.length === 1 ? namedPaths[0]! : null;

  const rootJoinedParent = rootJoinedPath === null ? null : parentPath(rootJoinedPath);
  if (rootJoinedParent !== null && index.directoryKeys.has(comparisonKey(rootJoinedParent))) {
    return null;
  }
  const folder = reference.slice(0, separatorIndex);
  const directories = endingWith(
    index.directoriesByName.get(lastSegment(folder).toLowerCase()),
    `/${folder}`,
  ).filter((directory) => workspaceRelativeFilePath(directory, workspaceRoot) === null);
  if (directories.length !== 1) return null;
  const directory = directories[0]!;
  return `${directory}${isWindowsAbsolutePath(directory) ? "\\" : "/"}${name}`;
}
