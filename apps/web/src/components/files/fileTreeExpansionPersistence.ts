import * as Schema from "effect/Schema";

import { setLocalStorageItem } from "~/hooks/useLocalStorage";

const FILE_TREE_EXPANDED_PREFIX = "t3code.fileTreeExpanded.";
const SAFE_KEY_CHARACTER = /[A-Za-z0-9.-]/;

/**
 * Escapes everything outside `[A-Za-z0-9.-]` as `_hex_`. `_` is itself escaped,
 * so the lone raw `_` between components is an unambiguous separator and two
 * different workspaces can never build the same key. localStorage tolerates
 * anything, but keeping the key inside this alphabet means it stays usable as
 * the platform key that has the stricter rules.
 */
function encodeKeyComponent(value: string): string {
  let encoded = "";
  for (const character of value) {
    encoded += SAFE_KEY_CHARACTER.test(character)
      ? character
      : `_${character.codePointAt(0)!.toString(16)}_`;
  }
  return encoded;
}

/** Workspace-scoped storage key: the tree is rooted at one environment + cwd. */
export function fileTreeExpansionStorageKey(environmentId: string, cwd: string): string {
  return `${FILE_TREE_EXPANDED_PREFIX}${encodeKeyComponent(environmentId)}_${encodeKeyComponent(cwd)}`;
}

export function writePersistedExpandedPaths(
  storageKey: string,
  paths: ReadonlySet<string> | readonly string[],
): void {
  try {
    setLocalStorageItem(storageKey, sanitizeList([...paths]), Schema.Array(Schema.String));
  } catch (error) {
    console.error(error);
  }
}

function sanitizeList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0 || seen.has(entry)) continue;
    seen.add(entry);
    result.push(entry);
  }
  return result;
}

function readRawStorageItem(storageKey: string): string | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage.getItem(storageKey);
  } catch (error) {
    console.error(error);
    return null;
  }
}

export function readPersistedExpandedPaths(storageKey: string): string[] {
  // Lenient on purpose: raw JSON plus filtering, so one odd entry does not
  // wipe the whole restored set.
  const raw = readRawStorageItem(storageKey);
  if (raw === null) return [];
  try {
    return sanitizeList(JSON.parse(raw));
  } catch (error) {
    console.error(error);
    return [];
  }
}

function treePathDepth(path: string): number {
  return path.split("/").filter((segment) => segment.length > 0).length;
}

/** Shallowest directories first so restore can load() from the root down. */
export function sortExpandedPathsParentFirst(paths: readonly string[]): string[] {
  return [...paths].sort((left, right) => {
    const depth = treePathDepth(left) - treePathDepth(right);
    if (depth !== 0) return depth;
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

/**
 * Ancestor tree paths of a directory, root-first and including itself, in the
 * trailing-slash form the tree registers ("apps/web/" -> ["apps/", "apps/web/"]).
 */
export function expandedPathAncestors(treePath: string): string[] {
  const ancestors: string[] = [];
  const segments = treePath.split("/").filter((segment) => segment.length > 0);
  for (let index = 1; index <= segments.length; index += 1) {
    ancestors.push(`${segments.slice(0, index).join("/")}/`);
  }
  return ancestors;
}

/** Drops persisted paths that are no longer listed directories. */
export function pruneExpandedPaths(
  paths: readonly string[],
  directoryPaths: ReadonlySet<string>,
): string[] {
  return paths.filter((path) => directoryPaths.has(path));
}
