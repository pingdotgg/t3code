/**
 * Fetch closure computation over the commit graph (DESIGN.md §3.5).
 *
 * Implements the git layer's `ClosureSource`: BFS from wants over the
 * `commits`/`commit_parents` tables stopping at negotiated haves,
 * generation-bounded, depth-bounded when the client sent `deepen <n>`, then
 * the full tree/blob closure of the new commits with one shared visited set.
 *
 * The v1 accepted fat (DESIGN.md §2.3): tree/blob closures of boundary
 * (common) commits are **not** subtracted, so an incremental fetch may
 * resend up to ~one snapshot's worth of trees/blobs — harmless to clients,
 * cheap to compute. Generation numbers are used soundly in one place: the
 * common-marking walk from haves never expands ancestors whose `gen` is
 * below the minimum generation seen in the want walk (such commits can
 * never be candidates, so the subtraction is unaffected).
 *
 * Manifest entries are ordered commits → tags → trees → blobs, and the
 * total is capped at {@link MANIFEST_CAP} objects (the documented v1
 * limit; larger repos wait for v1.1 whole-pack streaming).
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  parseTag,
  parseTree,
  treeEntryKind,
  type ObjectType,
  type Oid,
  type ParsedTag,
} from "../Protocol/ObjectCodec.ts";
import {
  StoreError,
  type ClosureRequest,
  type ClosureResult,
  type ClosureSource,
  type ManifestEntry,
  type ObjectMeta,
  type ObjectSource,
} from "../Protocol/Store.ts";
import type { SqlClient } from "./Sql.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Constants & errors
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maximum number of objects in one fetch manifest — 1 M for v1 (≈ 25 MB of
 * visited-set memory; DESIGN.md §3.5). Larger repos are a documented v1
 * limit until v1.1 whole-pack streaming.
 */
export const MANIFEST_CAP = 1_000_000;

/**
 * The fetch manifest exceeded {@link MANIFEST_CAP} objects. Surfaced to the
 * protocol layer so it can send a clean in-band `ERR` pkt; folded into
 * `StoreError` by {@link makeClosureSource} for callers that only speak the
 * narrow `ClosureSource` contract.
 */
export class ManifestTooLarge extends Schema.TaggedError<ManifestTooLarge>()(
  "ManifestTooLarge",
  { count: Schema.Number, cap: Schema.Number },
) {}

// ─────────────────────────────────────────────────────────────────────────────
// Options
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The object-store surface the closure walk needs: the read contract plus
 * batched metadata (satisfied structurally by `ObjectStore`; trivial to fake
 * in unit tests).
 */
export interface ClosureStore extends ObjectSource {
  /** Batched metadata for many oids (live only; absent = missing). */
  readonly getMetaBatch: (
    oids: ReadonlyArray<Oid>,
  ) => Effect.Effect<ReadonlyMap<Oid, ObjectMeta>, StoreError>;
  /** Batched inflated content — one statement per tree LEVEL (DESIGN §22). */
  readonly readContentBatch: (
    oids: ReadonlyArray<Oid>,
  ) => Effect.Effect<ReadonlyMap<Oid, Uint8Array>, StoreError>;
}

/**
 * Dependencies of the closure computation. Plain values (not Layers) so
 * `RepoObject.ts` wires it inside its inner per-instance effect.
 */
export interface ClosureOptions {
  /** The repo DO's SQL client (commit-graph reads). */
  readonly sql: SqlClient;
  /** The repo's object store (tree/tag content reads + manifest metadata). */
  readonly objects: ClosureStore;
  /**
   * Manifest object cap.
   * @default MANIFEST_CAP
   */
  readonly manifestCap?: number | undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Commit-graph reads (batched, chunked-IN)
// ─────────────────────────────────────────────────────────────────────────────

interface CommitNode {
  readonly oid: Oid;
  readonly tree: Oid;
  readonly gen: number;
}

interface CommitNodeRow extends Record<string, string | number> {
  readonly oid: string;
  readonly tree: string;
  readonly gen: number;
}

interface ParentRow extends Record<string, string | number> {
  readonly oid: string;
  readonly parent: string;
  readonly ord: number;
}

/** Loads `commits` rows for the given oids; missing oids are absent. */
const loadCommitNodes = (
  sql: SqlClient,
  oids: ReadonlyArray<Oid>,
): Effect.Effect<Map<Oid, CommitNode>, StoreError> =>
  Effect.gen(function* () {
    const map = new Map<Oid, CommitNode>();
    if (oids.length === 0) {
      return map;
    }
    const rows = yield* sql.inChunks<CommitNodeRow>(
      (ph) => `SELECT oid, tree, gen FROM commits WHERE oid IN (${ph})`,
      oids,
    );
    for (const row of rows) {
      map.set(row.oid, { oid: row.oid, tree: row.tree, gen: row.gen });
    }
    return map;
  });

/** Loads ordered parent lists for the given oids; missing = no parents. */
const loadParents = (
  sql: SqlClient,
  oids: ReadonlyArray<Oid>,
): Effect.Effect<Map<Oid, Array<Oid>>, StoreError> =>
  Effect.gen(function* () {
    const map = new Map<Oid, Array<Oid>>();
    if (oids.length === 0) {
      return map;
    }
    const rows = yield* sql.inChunks<ParentRow>(
      (ph) =>
        `SELECT oid, parent, ord FROM commit_parents WHERE oid IN (${ph})`,
      oids,
    );
    const grouped = new Map<Oid, Array<ParentRow>>();
    for (const row of rows) {
      const list = grouped.get(row.oid);
      if (list === undefined) {
        grouped.set(row.oid, [row]);
      } else {
        list.push(row);
      }
    }
    for (const [oid, list] of grouped) {
      list.sort((a, b) => a.ord - b.ord);
      map.set(
        oid,
        list.map((row) => row.parent),
      );
    }
    return map;
  });

// ─────────────────────────────────────────────────────────────────────────────
// Closure computation
// ─────────────────────────────────────────────────────────────────────────────

const dedup = (oids: ReadonlyArray<Oid>): Array<Oid> =>
  Array.from(new Set(oids));

/** Maximum tag→target indirections tolerated before declaring corruption. */
const MAX_TAG_CHAIN = 16;

/**
 * Computes the fetch closure (DESIGN.md §3.5) with the full error surface —
 * {@link ManifestTooLarge} kept as its own tag so `UploadPack` can turn it
 * into a clean in-band `ERR`. Use {@link makeClosureSource} when only the
 * narrow `ClosureSource` contract is needed.
 */
export const computeClosure = (options: ClosureOptions) =>
  Effect.fn(function* (request: ClosureRequest) {
    const { sql, objects } = options;
    const cap = options.manifestCap ?? MANIFEST_CAP;
    const depth = request.depth;

    // ── 1. Classify wants (peeling tag chains) ──────────────────────────────
    const commitSeeds: Array<Oid> = [];
    const tagOrder: Array<Oid> = [];
    const tagSet = new Set<Oid>();
    const treeRoots: Array<Oid> = [];
    const wantBlobs: Array<Oid> = [];

    const wants = dedup(request.wants);
    const wantMetas = yield* objects.getMetaBatch(wants);
    for (const want of wants) {
      const wantMeta = wantMetas.get(want);
      if (wantMeta === undefined) {
        return yield* Effect.fail(
          new StoreError({ reason: `want not found: ${want}` }),
        );
      }
      let meta: ObjectMeta = wantMeta;
      let hops = 0;
      let done = false;
      while (!done) {
        switch (meta.type as ObjectType) {
          case 1:
            commitSeeds.push(meta.oid);
            done = true;
            break;
          case 2:
            treeRoots.push(meta.oid);
            done = true;
            break;
          case 3:
            wantBlobs.push(meta.oid);
            done = true;
            break;
          case 4: {
            hops += 1;
            if (hops > MAX_TAG_CHAIN) {
              return yield* Effect.fail(
                new StoreError({ reason: `tag chain too deep at ${meta.oid}` }),
              );
            }
            if (!tagSet.has(meta.oid)) {
              tagSet.add(meta.oid);
              tagOrder.push(meta.oid);
            }
            const content: Uint8Array = yield* objects.readContent(meta.oid);
            const parsed: ParsedTag = yield* parseTag(content).pipe(
              Effect.mapError(
                (error) =>
                  new StoreError({
                    reason: `bad tag ${meta.oid}: ${error.reason}`,
                  }),
              ),
            );
            const target: ObjectMeta | undefined = yield* objects.getMeta(
              parsed.object,
            );
            if (target === undefined) {
              return yield* Effect.fail(
                new StoreError({
                  reason: `tag ${meta.oid} targets missing object ${parsed.object}`,
                }),
              );
            }
            meta = target;
            break;
          }
        }
      }
    }

    // ── 2. Boundaries ───────────────────────────────────────────────────────
    // Haves are boundaries only if we actually have them as commits.
    const repoShallowSet = new Set<Oid>(request.repoShallow ?? []);
    const haveNodes = yield* loadCommitNodes(sql, dedup(request.haves));
    const haveSet = new Set<Oid>(haveNodes.keys());
    const clientShallowSet = new Set<Oid>(request.clientShallow);
    // Without a deepen request the client's existing shallow tips are hard
    // walk boundaries (the client has the tips; keep its boundary in place).
    // With `deepen <n>` we re-walk by depth from the tips so previously
    // shallow history can be completed (→ `unshallow`).
    const shallowStopsActive = depth === undefined && clientShallowSet.size > 0;

    // ── 3. Want-BFS over the commit graph ───────────────────────────────────
    const candidateOrder: Array<CommitNode> = [];
    const candidateSet = new Set<Oid>();
    const parentsOf = new Map<Oid, ReadonlyArray<Oid>>();
    const depthOf = new Map<Oid, number>();
    let minCandidateGen = Number.POSITIVE_INFINITY;

    // A `have` normally implies the client holds its whole ancestry — but
    // NOT when that have is one of the client's shallow boundary tips and
    // this is a deepen request: the whole point of `deepen <n>` is to fetch
    // commits BEHIND those tips. Such seeds are walked through (so their
    // ancestors enter the manifest) but stay excluded from the output via
    // the common set.
    const walkThroughHave = (oid: Oid): boolean =>
      depth !== undefined && clientShallowSet.has(oid);
    let frontier = dedup(commitSeeds).filter(
      (oid) => !haveSet.has(oid) || walkThroughHave(oid),
    );
    const visited = new Set<Oid>(frontier);
    for (const oid of frontier) {
      depthOf.set(oid, 1);
    }
    while (frontier.length > 0) {
      const nodes = yield* loadCommitNodes(sql, frontier);
      const parents = yield* loadParents(sql, frontier);
      const next: Array<Oid> = [];
      for (const oid of frontier) {
        const node = nodes.get(oid);
        if (node === undefined) {
          return yield* Effect.fail(
            new StoreError({ reason: `commit graph missing commit ${oid}` }),
          );
        }
        candidateOrder.push(node);
        candidateSet.add(oid);
        if (node.gen < minCandidateGen) {
          minCandidateGen = node.gen;
        }
        const ps = parents.get(oid) ?? [];
        parentsOf.set(oid, ps);
        const d = depthOf.get(oid) ?? 1;
        if (depth !== undefined && d >= depth) {
          continue; // depth cut — do not expand parents
        }
        if (repoShallowSet.has(oid)) {
          continue; // repo-shallow boundary — parents were never ingested
        }
        for (const parent of ps) {
          if (
            visited.has(parent) ||
            (haveSet.has(parent) && !walkThroughHave(parent)) ||
            (shallowStopsActive && clientShallowSet.has(parent))
          ) {
            continue;
          }
          visited.add(parent);
          depthOf.set(parent, d + 1);
          next.push(parent);
        }
      }
      if (candidateOrder.length > cap) {
        return yield* Effect.fail(
          new ManifestTooLarge({ count: candidateOrder.length, cap }),
        );
      }
      frontier = next;
    }

    // ── 4. Common marking (have ancestry, generation-bounded) ───────────────
    const common = new Set<Oid>(haveSet);
    if (haveSet.size > 0 && candidateOrder.length > 0) {
      // Client-shallow haves contribute themselves to `common` but NOT
      // their ancestry — the client does not hold anything behind its
      // shallow boundary (that is what a deepen fetches).
      let hFrontier = Array.from(haveSet).filter(
        (oid) => !clientShallowSet.has(oid),
      );
      while (hFrontier.length > 0) {
        const parents = yield* loadParents(sql, hFrontier);
        const discovered: Array<Oid> = [];
        for (const oid of hFrontier) {
          for (const parent of parents.get(oid) ?? []) {
            if (!common.has(parent)) {
              common.add(parent);
              discovered.push(parent);
            }
          }
        }
        if (discovered.length === 0) {
          break;
        }
        // Expand only ancestors that could still intersect the candidate
        // set: everything below minCandidateGen can never be a candidate.
        const nodes = yield* loadCommitNodes(sql, discovered);
        hFrontier = discovered.filter((oid) => {
          const node = nodes.get(oid);
          return node !== undefined && node.gen >= minCandidateGen;
        });
      }
    }

    // ── 5. New commits & shallow bookkeeping ────────────────────────────────
    const newCommits = candidateOrder.filter((c) => !common.has(c.oid));
    const included = new Set<Oid>(newCommits.map((c) => c.oid));

    const shallow: Array<Oid> = [];
    const shallowSet = new Set<Oid>();
    if (
      depth !== undefined ||
      clientShallowSet.size > 0 ||
      repoShallowSet.size > 0
    ) {
      for (const commit of newCommits) {
        const ps = parentsOf.get(commit.oid) ?? [];
        const cut = ps.some(
          (parent) =>
            !included.has(parent) &&
            !common.has(parent) &&
            !clientShallowSet.has(parent),
        );
        if (cut) {
          shallow.push(commit.oid);
          shallowSet.add(commit.oid);
        }
      }
    }
    // A previously-shallow tip unshallows when this walk covered it (as a
    // new commit OR as a walked-through common have) and it is no longer a
    // boundary.
    const unshallow = Array.from(clientShallowSet).filter(
      (oid) =>
        (included.has(oid) || candidateSet.has(oid)) && !shallowSet.has(oid),
    );

    // ── 6. Tree/blob closure (shared visited set — the v1 fat) ──────────────
    const treeOrder: Array<Oid> = [];
    const blobOrder: Array<Oid> = [];
    const visitedObjects = new Set<Oid>();
    let total = newCommits.length + tagOrder.length;

    const failIfOverCap = (count: number) =>
      count > cap
        ? Effect.fail(new ManifestTooLarge({ count, cap }))
        : Effect.void;

    for (const blob of wantBlobs) {
      if (!visitedObjects.has(blob)) {
        visitedObjects.add(blob);
        blobOrder.push(blob);
        total += 1;
      }
    }
    yield* failIfOverCap(total);

    const treeQueue: Array<Oid> = [];
    for (const commit of newCommits) {
      treeQueue.push(commit.tree);
    }
    for (const root of treeRoots) {
      treeQueue.push(root);
    }
    // Level-order BFS (DESIGN §22): each level's trees are read with ONE
    // batched statement and inflated together, instead of one SQL round
    // trip per tree. Visitation order — and therefore the manifest — is the
    // same breadth-first order the queue produced.
    let level: Array<Oid> = treeQueue;
    while (level.length > 0) {
      const batch: Array<Oid> = [];
      for (const tree of level) {
        if (visitedObjects.has(tree)) continue;
        visitedObjects.add(tree);
        treeOrder.push(tree);
        total += 1;
        batch.push(tree);
      }
      yield* failIfOverCap(total);
      if (batch.length === 0) break;
      const contents = yield* objects.readContentBatch(batch);
      const next: Array<Oid> = [];
      for (const tree of batch) {
        const content = contents.get(tree);
        if (content === undefined) {
          return yield* Effect.fail(
            new StoreError({ reason: `tree ${tree} vanished during closure` }),
          );
        }
        const entries = yield* parseTree(content).pipe(
          Effect.mapError(
            (error) =>
              new StoreError({ reason: `bad tree ${tree}: ${error.reason}` }),
          ),
        );
        for (const entry of entries) {
          switch (treeEntryKind(entry.mode)) {
            case "tree":
              if (!visitedObjects.has(entry.oid)) {
                next.push(entry.oid);
              }
              break;
            case "blob":
              if (!visitedObjects.has(entry.oid)) {
                visitedObjects.add(entry.oid);
                blobOrder.push(entry.oid);
                total += 1;
              }
              break;
            case "commit":
              // gitlink (submodule) — the target commit lives in another repo
              break;
          }
        }
      }
      yield* failIfOverCap(total);
      level = next;
    }

    // ── 7. Materialize the manifest (commits → tags → trees → blobs) ────────
    const orderedOids: Array<Oid> = [
      ...newCommits.map((c) => c.oid),
      ...tagOrder,
      ...treeOrder,
      ...blobOrder,
    ];
    const metas = yield* objects.getMetaBatch(orderedOids);
    const entries: Array<ManifestEntry> = [];
    for (const oid of orderedOids) {
      const meta = metas.get(oid);
      if (meta === undefined) {
        return yield* Effect.fail(
          new StoreError({ reason: `object ${oid} vanished during closure` }),
        );
      }
      entries.push(meta);
    }

    const result: ClosureResult = { entries, shallow, unshallow };
    return result;
  });

/**
 * Creates the git layer's `ClosureSource` for one repo.
 * {@link ManifestTooLarge} is folded into `StoreError` here to fit the
 * narrow contract; protocol code that wants the distinct tag should call
 * {@link computeClosure} directly.
 */
export const makeClosureSource = (options: ClosureOptions): ClosureSource => {
  const compute = computeClosure(options);
  return {
    commitClosure: (request) =>
      compute(request).pipe(
        Effect.catchTag("ManifestTooLarge", (error) =>
          Effect.fail(
            new StoreError({
              reason: `manifest exceeds ${error.cap} objects (v1 cap; got ${error.count})`,
            }),
          ),
        ),
      ),
  };
};
