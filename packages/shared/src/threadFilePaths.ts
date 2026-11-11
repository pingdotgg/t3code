import type { OrchestrationV2TurnItem } from "@t3tools/contracts";

import {
  fileBasename,
  isAbsolutePath,
  isWindowsAbsolutePath,
  stripSlashPrefixedWindowsDrive,
  workspaceRelativeFilePath,
} from "./path.ts";

export interface ThreadFilePathIndex {
  readonly pathsByKey: ReadonlyMap<string, string>;
  readonly pathsByName: ReadonlyMap<string, ReadonlyArray<string>>;
  readonly directoryKeys: ReadonlySet<string>;
  readonly directoriesByName: ReadonlyMap<string, ReadonlyArray<string>>;
}

type EvidenceType = "file_change" | "dynamic_tool" | "file_search" | "command_execution";
/** Streaming-quiet item shapes qualify too; only these evidence types are read. */
export type ThreadFilePathItem =
  | Extract<OrchestrationV2TurnItem, { readonly type: EvidenceType }>
  | { readonly type: Exclude<OrchestrationV2TurnItem["type"], EvidenceType> };

const TOOL_INPUT_PATH_FIELDS = ["file_path", "notebook_path", "path", "filename", "fileName"];
const LITERAL_PATH_PATTERN = /^[\w./\\:@+ -]+$/;

function comparisonKey(path: string): string {
  const normalized = stripSlashPrefixedWindowsDrive(path)
    .replaceAll("\\", "/")
    .replace(/\/(?:\.\/)+/g, "/")
    .replace(/\/+$/, "");
  return isWindowsAbsolutePath(stripSlashPrefixedWindowsDrive(path))
    ? normalized.toLowerCase()
    : normalized;
}

function parentPath(path: string): string | null {
  const trimmed = path.replace(/[/\\]+$/, "");
  const separator = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return separator > 0 ? trimmed.slice(0, separator) : null;
}

function resolveOperand(path: string, cwd: string | null): string | null {
  if (!LITERAL_PATH_PATTERN.test(path) || path.startsWith("-")) return null;
  if (isAbsolutePath(path)) return path;
  if (path.split(/[/\\]/).some((segment) => segment.trim() !== segment)) return null;
  if (cwd === null || !isAbsolutePath(cwd)) return null;
  const windows = isWindowsAbsolutePath(cwd);
  if (!windows && path.includes("\\")) return null;
  const normalized = cwd.replaceAll("\\", "/");
  const root = normalized.match(windows ? /^(?:[A-Za-z]:\/|\/\/[^/]+\/[^/]+(?:\/|$))/ : /^\//)?.[0];
  if (!root) return null;
  const segments = normalized.slice(root.length).split("/").filter(Boolean);
  for (const segment of path.replaceAll("\\", "/").split("/")) {
    if (segment === "..") segments.pop();
    else if (segment !== "" && segment !== ".") segments.push(segment);
  }
  const resolved = `${root.endsWith("/") ? root : `${root}/`}${segments.join("/")}`;
  return windows ? resolved.replaceAll("/", "\\") : resolved;
}

// Unsupported shell syntax discards command evidence instead of guessing its cwd.
function commandPaths(input: string, cwd: string | null): string[] {
  const shell = input.match(
    /^(?:\/(?:usr\/)?bin\/)?(?:sh|bash|zsh)\s+-(?:c|lc)\s+(?:"([^"]*)"|'([^']*)')\s*$/,
  );
  if (shell) input = shell[1] ?? shell[2]!;
  if (/[|`$*?()<>#{}]/.test(input) || /(^|[^&])&([^&]|$)/.test(input)) return [];
  if (/\\[\s"']/.test(input)) return [];
  const tokens = /[ \t\r]+|&&|[;\n]|"[^"\n]*"|'[^'\n]*'|[^\s;&"']+/gy;
  const commands: string[][] = [];
  let words: string[] = [];
  let wordEnded = false;
  let offset = 0;
  while (offset < input.length) {
    const token = tokens.exec(input)?.[0];
    if (token === undefined) return [];
    offset = tokens.lastIndex;
    if (token === "&&" || token === ";" || token === "\n") {
      commands.push(words);
      words = [];
      wordEnded = false;
    } else if (/^[ \t\r]+$/.test(token)) {
      wordEnded = false;
    } else {
      if (wordEnded) return [];
      words.push(token.startsWith('"') || token.startsWith("'") ? token.slice(1, -1) : token);
      wordEnded = true;
    }
  }
  commands.push(words);

  const paths: string[] = [];
  let base = cwd;
  for (const [name, ...operands] of commands) {
    if (name === "cd") {
      const targets = operands[0] === "--" ? operands.slice(1) : operands;
      base = targets.length === 1 ? resolveOperand(targets[0]!, base) : null;
      if (base !== null) paths.push(base);
    } else if (name === "pushd" || name === "popd") {
      base = null;
    } else {
      for (const operand of operands) {
        const path = resolveOperand(operand, base);
        if (path !== null) paths.push(path);
      }
    }
  }
  return paths;
}

function turnItemPaths(item: ThreadFilePathItem, cwd: string | null): string[] {
  switch (item.type) {
    case "file_change":
      return [item.fileName, ...(item.changes ?? []).map((change) => change.path)];
    case "dynamic_tool": {
      const paths = item.viewedImagePath === undefined ? [] : [item.viewedImagePath];
      if (typeof item.input === "object" && item.input !== null) {
        const input = item.input as Record<string, unknown>;
        for (const field of TOOL_INPUT_PATH_FIELDS) {
          const value = input[field];
          if (typeof value === "string") paths.push(value);
        }
      }
      return paths;
    }
    case "file_search":
      return (item.results ?? []).map((result) => result.fileName);
    case "command_execution":
      return commandPaths(item.input, cwd);
    default:
      return [];
  }
}

// Projection updates retain immutable items, including large command inputs.
const pathsByItem = new WeakMap<
  ThreadFilePathItem,
  { readonly cwd: string | null; readonly paths: ReadonlyArray<string> }
>();

export function collectThreadFilePaths(
  items: ReadonlyArray<ThreadFilePathItem>,
  cwd: string | null,
): ReadonlyArray<string> {
  const paths = new Map<string, string>();
  for (const item of items) {
    let cached = pathsByItem.get(item);
    if (cached === undefined || cached.cwd !== cwd) {
      cached = {
        cwd,
        paths: turnItemPaths(item, cwd)
          .map((path) => (isAbsolutePath(path) ? path : resolveOperand(path, cwd)))
          .filter((path) => path !== null),
      };
      pathsByItem.set(item, cached);
    }
    for (const path of cached.paths) {
      const key = comparisonKey(path);
      if (!paths.has(key)) paths.set(key, path);
    }
  }
  return [...paths.values()];
}

function addByName(map: Map<string, string[]>, path: string) {
  const name = fileBasename(path).toLowerCase();
  const paths = map.get(name);
  if (paths) paths.push(path);
  else map.set(name, [path]);
}

export function createThreadFilePathIndex(paths: Iterable<string>): ThreadFilePathIndex {
  const pathsByKey = new Map<string, string>();
  const pathsByName = new Map<string, string[]>();
  const directoryKeys = new Set<string>();
  const directoriesByName = new Map<string, string[]>();
  for (const path of paths) {
    if (!isAbsolutePath(path)) continue;
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
  return (paths ?? []).filter((path) =>
    comparisonKey(path).endsWith(
      isWindowsAbsolutePath(stripSlashPrefixedWindowsDrive(path)) ? suffix.toLowerCase() : suffix,
    ),
  );
}

export function matchThreadFilePath(
  relativePath: string,
  cwd: string | null | undefined,
  index: ThreadFilePathIndex,
): string | null {
  const reference = relativePath.replaceAll("\\", "/").replace(/^(?:\.\/)+/, "");
  const segments = reference.split("/");
  if (
    isAbsolutePath(reference) ||
    reference.startsWith("~") ||
    segments.length < 2 ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    return null;
  }
  const rootJoined = cwd ? `${cwd.replace(/[/\\]+$/, "")}/${reference}` : null;
  if (rootJoined !== null && index.pathsByKey.has(comparisonKey(rootJoined))) return null;
  const name = segments[segments.length - 1]!;
  const matches = endingWith(index.pathsByName.get(name.toLowerCase()), `/${reference}`);
  if (matches.length > 0) return matches.length === 1 ? matches[0]! : null;

  const rootFolder = rootJoined === null ? null : parentPath(rootJoined);
  if (rootFolder !== null && index.directoryKeys.has(comparisonKey(rootFolder))) return null;
  const folder = segments.slice(0, -1).join("/");
  const directories = endingWith(
    index.directoriesByName.get(fileBasename(folder).toLowerCase()),
    `/${folder}`,
  ).filter((directory) => workspaceRelativeFilePath(directory, cwd) === null);
  if (directories.length !== 1) return null;
  const directory = directories[0]!;
  return `${directory.replace(/[/\\]+$/, "")}${isWindowsAbsolutePath(directory) ? "\\" : "/"}${name}`;
}
