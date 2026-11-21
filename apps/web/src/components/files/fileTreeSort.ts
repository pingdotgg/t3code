import type { FileTreeSortComparator } from "@pierre/trees";
import * as Schema from "effect/Schema";

export const FileTreeSortKey = Schema.Literals(["name", "modified"]);
export type FileTreeSortKey = typeof FileTreeSortKey.Type;
export const FileTreeSortDirection = Schema.Literals(["asc", "desc"]);
export type FileTreeSortDirection = typeof FileTreeSortDirection.Type;
export const FileTreeSortOrder = Schema.Struct({
  key: FileTreeSortKey,
  direction: FileTreeSortDirection,
});
export type FileTreeSortOrder = typeof FileTreeSortOrder.Type;
export const DEFAULT_FILE_TREE_SORT_ORDER: FileTreeSortOrder = { key: "name", direction: "asc" };

interface SegmentSortKey {
  readonly lower: string;
  readonly tokens: readonly (string | number)[];
}

// Mirrors @pierre/trees' path-store sort (dist/path-store/src/sort.js), which orders
// the default tree: case-insensitive, digit runs compared as numbers. The package
// does not export it, and its utils/sortChildren.js dot-first comparator is not used.
function createSegmentSortKey(segment: string): SegmentSortKey {
  const lower = segment.toLowerCase();
  const tokens = lower
    .split(/(\d+)/)
    .flatMap((part, index) =>
      part === ""
        ? []
        : [index % 2 === 1 ? [...part].reduce((n, digit) => n * 10 + Number(digit), 0) : part],
    );
  return { lower, tokens };
}

function compareSegmentSortKeys(left: SegmentSortKey, right: SegmentSortKey): number {
  const shared = Math.min(left.tokens.length, right.tokens.length);
  for (let index = 0; index < shared; index++) {
    const leftToken = left.tokens[index]!;
    const rightToken = right.tokens[index]!;
    if (leftToken === rightToken) continue;
    if (typeof leftToken === "number" && typeof rightToken === "number") {
      return leftToken < rightToken ? -1 : 1;
    }
    const leftText = String(leftToken);
    const rightText = String(rightToken);
    if (leftText !== rightText) return leftText < rightText ? -1 : 1;
  }
  if (left.tokens.length !== right.tokens.length) {
    return left.tokens.length < right.tokens.length ? -1 : 1;
  }
  if (left.lower !== right.lower) return left.lower < right.lower ? -1 : 1;
  return 0;
}

export function createFileTreeSortComparator(
  order: FileTreeSortOrder,
  lookupMtime: (path: string) => number | undefined,
): FileTreeSortComparator {
  const sortKeys = new Map<string, SegmentSortKey>();
  const sortKeyOf = (segment: string): SegmentSortKey => {
    let key = sortKeys.get(segment);
    if (key === undefined) {
      key = createSegmentSortKey(segment);
      sortKeys.set(segment, key);
    }
    return key;
  };
  const compareNamesAsc = (left: string, right: string): number =>
    compareSegmentSortKeys(sortKeyOf(left), sortKeyOf(right)) ||
    (left === right ? 0 : left < right ? -1 : 1);

  const compareMtimes = (left: number | undefined, right: number | undefined): number => {
    if (left === right) return 0;
    if (left === undefined) return 1;
    if (right === undefined) return -1;
    return (order.direction === "asc" ? left - right : right - left) < 0 ? -1 : 1;
  };

  // The tree sorts whole paths at build time and sibling pairs afterwards, so compare
  // at the first segment where the two paths diverge.
  return (left, right) => {
    const shared = Math.min(left.segments.length, right.segments.length);
    for (let depth = 0; depth < shared; depth++) {
      const leftSegment = left.segments[depth]!;
      const rightSegment = right.segments[depth]!;
      if (leftSegment === rightSegment) continue;
      const leftIsDirectory = depth < left.segments.length - 1 || left.isDirectory;
      const rightIsDirectory = depth < right.segments.length - 1 || right.isDirectory;
      if (leftIsDirectory !== rightIsDirectory) return leftIsDirectory ? -1 : 1;
      if (order.key === "modified") {
        const byTime = compareMtimes(
          lookupMtime(left.segments.slice(0, depth + 1).join("/")),
          lookupMtime(right.segments.slice(0, depth + 1).join("/")),
        );
        if (byTime !== 0) return byTime;
        return compareNamesAsc(leftSegment, rightSegment);
      }
      const byName = compareNamesAsc(leftSegment, rightSegment);
      return order.direction === "asc" ? byName : -byName;
    }
    if (left.segments.length !== right.segments.length) {
      return left.segments.length < right.segments.length ? -1 : 1;
    }
    if (left.isDirectory === right.isDirectory) return 0;
    return left.isDirectory ? -1 : 1;
  };
}

export interface FileTreeTimestamps {
  readonly entryKinds: ReadonlyMap<string, unknown>;
  readonly mtimes: ReadonlyMap<string, number>;
}

/** New paths can be inserted in place; only a kept path's changed time needs a full re-sort. */
export function hasKeptEntryMtimeChanged(previous: FileTreeTimestamps, next: FileTreeTimestamps) {
  for (const path of next.entryKinds.keys()) {
    if (previous.entryKinds.has(path) && previous.mtimes.get(path) !== next.mtimes.get(path)) {
      return true;
    }
  }
  return false;
}
