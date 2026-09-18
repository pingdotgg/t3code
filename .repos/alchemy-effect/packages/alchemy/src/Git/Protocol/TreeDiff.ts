/**
 * Pure recursive tree diff (the server-side diff surface, DESIGN.md §5).
 *
 * Compares two trees keyed by entry **name** (NOT a two-pointer merge —
 * git's canonical sort treats directories as `name/`, so a name that is a
 * blob in one tree and a tree in the other would mis-pair). Only descends
 * into subtree pairs whose oids differ; identical oids (with identical
 * modes) are skipped without reading the subtree at all. That pruning is
 * what makes a 12k-file tree cost O(changed) — a commit touching k files
 * opens only the ~k·depth trees on the changed root-to-leaf paths (each a
 * single SQLite row read + inflate of a few KB).
 *
 * Worst case (root commit: everything added) is bounded by the caps:
 * recursion **stops descending** once {@link MAX_DIFF_FILES} entries are
 * emitted (it does not enumerate-then-truncate) and
 * {@link MAX_DIFF_TREE_READS} bounds tree opens defensively.
 *
 * Like the rest of `src/Git/Protocol/`, this module depends only on data-shaped
 * store contracts so it stays unit-testable with in-memory fakes.
 */
import * as Effect from "effect/Effect";
import {
  encodeTree,
  GITLINK_MODE,
  hashObject,
  ObjectType,
  parseTree,
  TREE_MODE,
  treeEntryKind,
  type Oid,
  type TreeEntry,
} from "./ObjectCodec.ts";
import { StoreError } from "./Store.ts";

/** Max files emitted by a tree diff before `truncated: true`. */
export const MAX_DIFF_FILES = 1000;

/**
 * Defensive bound on tree objects opened per diff (a 12k-file repo with
 * identical-subtree pruning opens O(changed-paths · depth), typically <50).
 */
export const MAX_DIFF_TREE_READS = 5000;

/** One changed file (see the REST `DiffEntry` schema). */
export interface DiffEntryData {
  readonly path: string;
  readonly status: "added" | "removed" | "modified";
  readonly oldOid?: string | undefined;
  readonly newOid?: string | undefined;
  readonly oldMode?: string | undefined;
  readonly newMode?: string | undefined;
  readonly oldSize?: number | undefined;
  readonly newSize?: number | undefined;
}

/** Result of {@link diffTrees}. */
export interface TreeDiffResult {
  readonly files: Array<DiffEntryData>;
  readonly truncated: boolean;
}

/**
 * The read surface {@link diffTrees} needs — a structural subset of
 * `ObjectStore` (`readContent` + `getMetaBatch`).
 */
export interface TreeDiffObjects {
  /** Reads and inflates the full object content. */
  readonly readContent: (oid: Oid) => Effect.Effect<Uint8Array, StoreError>;
  /** Batched metadata; missing oids are simply absent from the map. */
  readonly getMetaBatch: (
    oids: ReadonlyArray<Oid>,
  ) => Effect.Effect<ReadonlyMap<Oid, { readonly size: number }>, StoreError>;
}

/**
 * Recursive tree diff. `oldTree`/`newTree` are tree oids; `undefined`
 * means the empty tree on that side (a root commit diffs against
 * `undefined` and every file comes out `added`).
 *
 * Mode-only changes (same blob oid, different mode) still report
 * `modified`. Kind changes (blob↔tree, gitlink↔tree) emit the removal of
 * everything on the old side and the addition of everything on the new
 * side. Gitlink (mode `160000`) entries are leaves whose oids are commit
 * oids — they carry no sizes.
 */
export const diffTrees = (
  objects: TreeDiffObjects,
  oldTree: Oid | undefined,
  newTree: Oid | undefined,
): Effect.Effect<TreeDiffResult, StoreError> =>
  Effect.gen(function* () {
    const files: Array<DiffEntryData> = [];
    let treeReads = 0;
    let truncated = false;

    const readTree = Effect.fn(function* (oid: Oid) {
      if (++treeReads > MAX_DIFF_TREE_READS) {
        truncated = true;
        return [] as ReadonlyArray<TreeEntry>;
      }
      const content = yield* objects.readContent(oid);
      return yield* parseTree(content).pipe(
        Effect.mapError((e) => new StoreError({ reason: e.reason })),
      );
    });

    const emit = (entry: DiffEntryData): boolean => {
      if (files.length >= MAX_DIFF_FILES) {
        truncated = true;
        return false;
      }
      files.push(entry);
      return true;
    };

    /** Emit every blob/gitlink under `tree` as added or removed. */
    const emitAll = (
      tree: Oid,
      prefix: string,
      side: "added" | "removed",
    ): Effect.Effect<void, StoreError> =>
      Effect.gen(function* () {
        if (truncated) return;
        const entries = yield* readTree(tree);
        for (const e of entries) {
          if (truncated) return;
          const path = prefix + e.name;
          const kind = treeEntryKind(e.mode);
          if (kind === "tree") {
            yield* emitAll(e.oid, `${path}/`, side);
            continue;
          }
          // blob or gitlink — a leaf either way
          emit(
            side === "added"
              ? { path, status: "added", newOid: e.oid, newMode: e.mode }
              : { path, status: "removed", oldOid: e.oid, oldMode: e.mode },
          );
        }
      });

    const walk = (
      oldOid: Oid | undefined,
      newOid: Oid | undefined,
      prefix: string,
    ): Effect.Effect<void, StoreError> =>
      Effect.gen(function* () {
        if (truncated) return;
        if (oldOid === newOid) return; // identical-subtree prune (root incl.)
        if (oldOid === undefined) {
          if (newOid !== undefined) yield* emitAll(newOid, prefix, "added");
          return;
        }
        if (newOid === undefined) {
          yield* emitAll(oldOid, prefix, "removed");
          return;
        }
        const oldEntries = yield* readTree(oldOid);
        const newEntries = yield* readTree(newOid);
        const oldByName = new Map(oldEntries.map((e) => [e.name, e]));
        const newByName = new Map(newEntries.map((e) => [e.name, e]));
        const names = Array.from(
          new Set([...oldByName.keys(), ...newByName.keys()]),
        ).sort(); // deterministic output order
        for (const name of names) {
          if (truncated) return;
          const o = oldByName.get(name);
          const n = newByName.get(name);
          const path = prefix + name;
          if (o === undefined) {
            // added on the new side
            const kind = treeEntryKind(n!.mode);
            if (kind === "tree") yield* emitAll(n!.oid, `${path}/`, "added");
            else {
              emit({ path, status: "added", newOid: n!.oid, newMode: n!.mode });
            }
            continue;
          }
          if (n === undefined) {
            const kind = treeEntryKind(o.mode);
            if (kind === "tree") yield* emitAll(o.oid, `${path}/`, "removed");
            else {
              emit({ path, status: "removed", oldOid: o.oid, oldMode: o.mode });
            }
            continue;
          }
          if (o.oid === n.oid && o.mode === n.mode) continue; // untouched — prune
          const oKind = treeEntryKind(o.mode);
          const nKind = treeEntryKind(n.mode);
          if (oKind === "tree" && nKind === "tree") {
            yield* walk(o.oid, n.oid, `${path}/`); // descend: oids differ
          } else if (oKind === "tree" || nKind === "tree") {
            // kind change (blob↔tree, gitlink↔tree): removed + added
            if (oKind === "tree") yield* emitAll(o.oid, `${path}/`, "removed");
            else {
              emit({ path, status: "removed", oldOid: o.oid, oldMode: o.mode });
            }
            if (nKind === "tree") yield* emitAll(n.oid, `${path}/`, "added");
            else {
              emit({ path, status: "added", newOid: n.oid, newMode: n.mode });
            }
          } else {
            // blob/gitlink on both sides: content and/or mode change.
            // Mode-only change (o.oid === n.oid) still reports `modified`.
            emit({
              path,
              status: "modified",
              oldOid: o.oid,
              newOid: n.oid,
              oldMode: o.mode,
              newMode: n.mode,
            });
          }
        }
      });

    yield* walk(oldTree, newTree, "");

    // Fill sizes for blob entries in ONE chunked metadata query so clients
    // can gate binary/oversize files without fetching. Gitlink oids won't
    // be in `objects` and simply stay size-less.
    const blobOids = new Set<Oid>();
    for (const f of files) {
      if (f.oldOid !== undefined && f.oldMode !== GITLINK_MODE) {
        blobOids.add(f.oldOid);
      }
      if (f.newOid !== undefined && f.newMode !== GITLINK_MODE) {
        blobOids.add(f.newOid);
      }
    }
    const metas = yield* objects.getMetaBatch(Array.from(blobOids));
    const sized = files.map((f): DiffEntryData => ({
      ...f,
      oldSize: f.oldOid !== undefined ? metas.get(f.oldOid)?.size : undefined,
      newSize: f.newOid !== undefined ? metas.get(f.newOid)?.size : undefined,
    }));
    return { files: sized, truncated };
  });

// ─────────────────────────────────────────────────────────────────────────────
// conflictingPaths — the trivial-merge admissibility test
// ─────────────────────────────────────────────────────────────────────────────

/** `true` when both sides made the identical change (same result). */
const identicalChange = (a: DiffEntryData, b: DiffEntryData): boolean =>
  a.status === b.status && a.newOid === b.newOid && a.newMode === b.newMode;

/**
 * The paths that make a three-way merge non-trivial: changed on **both**
 * sides relative to the merge base (minus paths where both sides made the
 * identical change — same new oid+mode, or both deleted), plus
 * directory/file collisions where a leaf now occupies `p` on one side
 * while the other side changed something under `p/`. Sorted.
 */
export const conflictingPaths = (
  baseChanges: ReadonlyArray<DiffEntryData>,
  headChanges: ReadonlyArray<DiffEntryData>,
): Array<string> => {
  const conflicts = new Set<string>();
  const baseBy = new Map(baseChanges.map((f) => [f.path, f]));
  const headBy = new Map(headChanges.map((f) => [f.path, f]));
  for (const [path, head] of headBy) {
    const base = baseBy.get(path);
    if (base !== undefined && !identicalChange(base, head)) {
      conflicts.add(path);
    }
  }
  // Directory/file collision: one side's add/modify puts a *leaf* at `dir`
  // while the other side changes a path under `dir/` — the leaf and the
  // directory cannot both exist. (A `removed` ancestor never collides: at
  // the merge base a name is either a leaf or a directory, never both.)
  const addAncestorConflicts = (
    leaves: ReadonlyMap<string, DiffEntryData>,
    others: ReadonlyMap<string, DiffEntryData>,
  ) => {
    for (const path of others.keys()) {
      let idx = path.lastIndexOf("/");
      while (idx > 0) {
        const dir = path.slice(0, idx);
        const leaf = leaves.get(dir);
        if (leaf !== undefined && leaf.newOid !== undefined) {
          conflicts.add(path);
        }
        idx = dir.lastIndexOf("/");
      }
    }
  };
  addAncestorConflicts(baseBy, headBy);
  addAncestorConflicts(headBy, baseBy);
  return Array.from(conflicts).sort();
};

// ─────────────────────────────────────────────────────────────────────────────
// applyTreeChanges — the trivial-merge tree builder
// ─────────────────────────────────────────────────────────────────────────────

/** A tree object created by {@link applyTreeChanges} (bottom-up order). */
export interface NewTreeObject {
  readonly oid: Oid;
  readonly content: Uint8Array;
}

/** Result of {@link applyTreeChanges}. */
export interface ApplyTreeChangesResult {
  /** Root tree oid after the changes (may equal `baseTree` on a no-op). */
  readonly root: Oid;
  /**
   * Every tree object whose content was (re)built, bottom-up. Some may
   * already exist in the store — staging is idempotent, so callers just
   * stage them all.
   */
  readonly newTrees: ReadonlyArray<NewTreeObject>;
}

/** One directory level of the nested change tree. */
interface ChangeNode {
  /** Leaf change addressed exactly at this name. */
  leaf?: DiffEntryData;
  /** Changes below this name (it is a directory on some side). */
  children?: Map<string, ChangeNode>;
}

/**
 * Applies leaf-level changes (a {@link diffTrees} file list, e.g. the
 * mergeBase→head changes of a trivial three-way merge) onto `baseTree`,
 * rebuilding every touched directory bottom-up with the canonical
 * {@link encodeTree}. Directories that become empty are dropped from their
 * parent (git has no empty trees in practice).
 *
 * Kind changes compose from the diff's leaf pairs without special cases:
 * dir→file arrives as deletions under `p/` plus a leaf add at `p` (the
 * emptied subtree is dropped, then the blob wins); file→dir is the mirror
 * (the rebuilt subtree replaces the removed blob).
 *
 * **No blob is ever created** — every blob/gitlink oid referenced by an
 * add/modify must already exist in the store (it came in with the head
 * push). Gitlink oids are commit oids and are exempt from the existence
 * assertion; any missing *blob* fails with {@link StoreError} (connectivity
 * invariant).
 */
export const applyTreeChanges = (
  objects: TreeDiffObjects,
  baseTree: Oid,
  changes: ReadonlyArray<DiffEntryData>,
): Effect.Effect<ApplyTreeChangesResult, StoreError> =>
  Effect.gen(function* () {
    // Connectivity invariant: referenced blobs must already exist.
    const requiredBlobs = new Set<Oid>();
    for (const change of changes) {
      if (
        change.newOid !== undefined &&
        change.newMode !== undefined &&
        treeEntryKind(change.newMode) !== "commit"
      ) {
        requiredBlobs.add(change.newOid);
      }
    }
    if (requiredBlobs.size > 0) {
      const metas = yield* objects.getMetaBatch(Array.from(requiredBlobs));
      for (const oid of requiredBlobs) {
        if (!metas.has(oid)) {
          return yield* new StoreError({
            reason: `applyTreeChanges: referenced blob ${oid} is missing from the store`,
          });
        }
      }
    }

    // Build the nested change tree keyed by path segment.
    const rootNode: ChangeNode = { children: new Map() };
    for (const change of changes) {
      const segments = change.path.split("/");
      let node = rootNode;
      for (let i = 0; i < segments.length; i++) {
        node.children ??= new Map();
        const name = segments[i]!;
        let next = node.children.get(name);
        if (next === undefined) {
          next = {};
          node.children.set(name, next);
        }
        node = next;
      }
      node.leaf = change;
    }

    const newTrees: Array<NewTreeObject> = [];

    const readEntries = Effect.fn(function* (oid: Oid) {
      const content = yield* objects.readContent(oid);
      return yield* parseTree(content).pipe(
        Effect.mapError((e) => new StoreError({ reason: e.reason })),
      );
    });

    /**
     * Rebuilds one directory: `baseOid` is the base-side subtree (absent
     * when the directory is new), `node.children` the changes below it.
     * Returns the resulting tree oid, or `undefined` when it came out
     * empty.
     */
    const build = (
      baseOid: Oid | undefined,
      children: Map<string, ChangeNode>,
    ): Effect.Effect<Oid | undefined, StoreError> =>
      Effect.gen(function* () {
        const baseEntries =
          baseOid === undefined ? [] : yield* readEntries(baseOid);
        const byName = new Map(baseEntries.map((e) => [e.name, e]));
        for (const [name, node] of children) {
          const base = byName.get(name);
          // 1. children first: rebuild the subtree below this name.
          let subtree: Oid | undefined;
          if (node.children !== undefined) {
            const subtreeBase =
              base !== undefined && treeEntryKind(base.mode) === "tree"
                ? base.oid
                : undefined;
            subtree = yield* build(subtreeBase, node.children);
          }
          // 2. the leaf op at this exact name decides the entry.
          if (
            node.leaf !== undefined &&
            node.leaf.newOid !== undefined &&
            node.leaf.newMode !== undefined
          ) {
            // added/modified blob or gitlink — the leaf wins.
            byName.set(name, {
              mode: node.leaf.newMode,
              name,
              oid: node.leaf.newOid,
            });
          } else if (node.children !== undefined) {
            // subtree result (also covers file→dir: the removed blob is
            // replaced by the rebuilt subtree, or dropped when empty).
            if (subtree === undefined) byName.delete(name);
            else byName.set(name, { mode: TREE_MODE, name, oid: subtree });
          } else if (node.leaf !== undefined) {
            // removed leaf
            byName.delete(name);
          }
        }
        const entries = Array.from(byName.values());
        if (entries.length === 0) return undefined;
        const content = yield* encodeTree(entries).pipe(
          Effect.mapError((e) => new StoreError({ reason: e.reason })),
        );
        const oid = yield* hashObject(ObjectType.tree, content);
        if (oid !== baseOid) {
          newTrees.push({ oid, content });
        }
        return oid;
      });

    const root = yield* build(baseTree, rootNode.children ?? new Map());
    if (root === undefined) {
      // Everything was deleted: the canonical empty tree.
      const content = new Uint8Array(0);
      const oid = yield* hashObject(ObjectType.tree, content);
      newTrees.push({ oid, content });
      return { root: oid, newTrees };
    }
    return { root, newTrees };
  });
