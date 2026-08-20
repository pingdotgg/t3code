// @effect-diagnostics nodeBuiltinImport:off
/**
 * SubmoduleSync - pure gitlink diffing and discovery for project mirroring.
 *
 * Gitlinks (mode 160000 tree entries) are opaque to `git bundle`/`add -A`/
 * `read-tree`: the objects of a submodule's own repository never travel with
 * the superproject. This module never runs git directly; it calls into the
 * injected `GitSync` service to find which gitlink paths changed between two
 * trees, and to walk into already-materialized nested repositories, so
 * callers can mirror each changed submodule through the same seed/sync
 * primitives used for the superproject.
 *
 * @module SubmoduleSync
 */
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";

import { GitSync, type GitSyncCommandError } from "./GitSync.ts";

/** Submodules-of-submodules are mirrored up to this many levels deep. */
export const MIRROR_SUBMODULE_MAX_DEPTH = 4;

export interface GitlinkDiffEntry {
  readonly path: string;
  readonly baseOid: string | null;
  readonly targetOid: string | null;
  readonly status: "added" | "changed" | "removed";
}

/**
 * Diff gitlinks between two trees. `baseTreeOid` is null for a first seed,
 * in which case every gitlink in `targetTreeOid` is reported as "added".
 * Paths whose oid did not change are dropped entirely.
 */
export const diffGitlinks = Effect.fn("SubmoduleSync.diffGitlinks")(function* (
  root: string,
  baseTreeOid: string | null,
  targetTreeOid: string,
): Effect.fn.Return<ReadonlyArray<GitlinkDiffEntry>, GitSyncCommandError, GitSync> {
  const gitSync = yield* GitSync;
  const targetLinks = yield* gitSync.listGitlinks(root, targetTreeOid);
  const baseLinks = baseTreeOid === null ? [] : yield* gitSync.listGitlinks(root, baseTreeOid);

  const basePaths = new Map(baseLinks.map((link) => [link.path, link.oid]));
  const targetPaths = new Map(targetLinks.map((link) => [link.path, link.oid]));
  const allPaths = new Set([...basePaths.keys(), ...targetPaths.keys()]);

  const entries: GitlinkDiffEntry[] = [];
  for (const gitlinkPath of allPaths) {
    const baseOid = basePaths.get(gitlinkPath) ?? null;
    const targetOid = targetPaths.get(gitlinkPath) ?? null;
    if (baseOid === targetOid) continue;
    const status = baseOid === null ? "added" : targetOid === null ? "removed" : "changed";
    entries.push({ path: gitlinkPath, baseOid, targetOid, status });
  }
  return entries;
});

export interface DiscoveredGitlink {
  /** Path relative to `root`, e.g. "vendor/lib" or "vendor/lib/nested-dep". */
  readonly path: string;
  readonly oid: string;
  readonly depth: number;
}

/**
 * Recursively discover every gitlink reachable from `treeOid`, including
 * gitlinks inside already-materialized nested repositories on disk (a
 * submodule-of-a-submodule only becomes visible once its parent has been
 * checked out at `path.join(root, parentPath)`). Depth is capped at
 * `MIRROR_SUBMODULE_MAX_DEPTH`; primary support is depth 1 (direct
 * submodules of the superproject).
 */
export const discoverAllGitlinks = Effect.fn("SubmoduleSync.discoverAllGitlinks")(function* (
  root: string,
  treeOid: string,
  depth = 0,
): Effect.fn.Return<ReadonlyArray<DiscoveredGitlink>, GitSyncCommandError, GitSync> {
  if (depth >= MIRROR_SUBMODULE_MAX_DEPTH) return [];
  const gitSync = yield* GitSync;
  const links = yield* gitSync.listGitlinks(root, treeOid);
  const results: DiscoveredGitlink[] = [];
  for (const link of links) {
    results.push({ path: link.path, oid: link.oid, depth });
    const nestedRoot = NodePath.join(root, link.path);
    const isNestedRepo = yield* gitSync.isRepository(nestedRoot);
    if (!isNestedRepo) continue;
    const nestedHead = yield* gitSync.headCommit(nestedRoot);
    if (nestedHead === null) continue;
    const nestedTree = yield* gitSync.treeOfCommit(nestedRoot, nestedHead);
    if (nestedTree === null) continue;
    const nested = yield* discoverAllGitlinks(nestedRoot, nestedTree, depth + 1);
    for (const entry of nested) {
      results.push({ path: `${link.path}/${entry.path}`, oid: entry.oid, depth: entry.depth });
    }
  }
  return results;
});
