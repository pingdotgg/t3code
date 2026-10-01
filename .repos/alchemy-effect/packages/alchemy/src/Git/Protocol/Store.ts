/**
 * Abstract storage interfaces the protocol choreography is written against.
 *
 * The concrete implementations live in `src/store/` (DO SQLite + R2); the
 * protocol layer (`UploadPack`, `ReceivePack`, `PackParser`, `PackWriter`,
 * `Advertise`) depends only on these data-shaped contracts, which keeps the
 * entire `src/Git/Protocol/` layer unit-testable in plain bun with in-memory fakes.
 */
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Stream from "effect/Stream";
import type { ObjectType, Oid } from "./ObjectCodec.ts";

/**
 * Error produced by any of the abstract store interfaces. Concrete
 * implementations wrap their own failures (SQL, R2) into this tag so the
 * protocol layer's error unions stay closed.
 */
export class StoreError extends Schema.TaggedError<StoreError>()("StoreError", {
  reason: Schema.String,
}) {}

/**
 * Where an object's compressed bytes live (mirrors the `objects.location`
 * column): `row` = SQLite BLOB, `r2` = oversize loose object in R2,
 * `pack` = v1.1 compacted pack in R2.
 */
export type ObjectLocation = "row" | "r2" | "pack";

/**
 * Metadata for one stored object — also the shape of a pack manifest entry
 * (the fetch closure materializes a list of these, and `PackWriter` streams
 * from it).
 */
export interface ObjectMeta {
  readonly oid: Oid;
  readonly type: ObjectType;
  /** Uncompressed size in bytes. */
  readonly size: number;
  /** Stored (zlib-compressed) size in bytes. */
  readonly zsize: number;
  /** Storage tier the zdata lives in. */
  readonly location: ObjectLocation;
}

/**
 * One entry of a fetch-pack manifest. Alias of {@link ObjectMeta} — the
 * closure walk produces exactly the metadata the pack emitter needs.
 */
export type ManifestEntry = ObjectMeta;

/**
 * Read access to the object store, as needed by pack parsing (thin-pack base
 * resolution), pack writing (zdata streaming), negotiation (have existence),
 * and the push connectivity check.
 *
 * All byte payloads are `zlib(content)` **without** the loose header, so pack
 * emission is `varint(type,size) + zdata` verbatim.
 */
export interface ObjectSource {
  /** Whether an object exists (live objects only, not staged). */
  readonly has: (oid: Oid) => Effect.Effect<boolean, StoreError>;
  /**
   * Filters the given oids down to the subset that exists in the store.
   * Implementations batch with chunked `IN` lists; order is not guaranteed.
   */
  readonly filterExisting: (
    oids: ReadonlyArray<Oid>,
  ) => Effect.Effect<ReadonlyArray<Oid>, StoreError>;
  /** Object metadata, or `undefined` when the object does not exist. */
  readonly getMeta: (
    oid: Oid,
  ) => Effect.Effect<ObjectMeta | undefined, StoreError>;
  /**
   * Streams the stored compressed bytes (`zlib(content)`, no loose header)
   * regardless of location (row BLOB, R2 get, v1.1 ranged pack read).
   */
  readonly readZData: (oid: Oid) => Stream.Stream<Uint8Array, StoreError>;
  /**
   * Reads and inflates the full object content. Used for thin-pack base
   * resolution and tree/commit walks; callers must respect the per-object
   * size cap before requesting.
   */
  readonly readContent: (oid: Oid) => Effect.Effect<Uint8Array, StoreError>;
  /**
   * Emits `varint(type,size) + zdata` for every entry as a stream of LARGE
   * chunks: objects are read in batches (one statement per ~256) and
   * concatenated, and pack-resident objects are visited in pack order so
   * the window cache is sequential. Optional — sources without batching
   * fall back to one `readZData` per entry (DESIGN §22).
   */
  readonly packEntries?:
    | ((
        entries: ReadonlyArray<ManifestEntry>,
      ) => Stream.Stream<Uint8Array, StoreError>)
    | undefined;
}

/**
 * One advertised ref: full name, tip oid, and — for annotated tags — the
 * peeled target commit oid (advertised as a `^{}` line).
 */
export interface RefRecord {
  /** Full ref name, e.g. `refs/heads/main`, `refs/tags/v1`. */
  readonly name: string;
  readonly oid: Oid;
  /** Peeled target for annotated tags (`refs/tags/x^{}` advertisement). */
  readonly peeled?: Oid | undefined;
}

/**
 * A point-in-time snapshot of the ref namespace used to build the v0
 * advertisement. `HEAD` is virtual: it resolves to
 * `refs/heads/<defaultBranch>` when that ref exists.
 */
export interface RefsSnapshot {
  /** The repo's default branch short name, e.g. `main`. */
  readonly defaultBranch: string;
  /** All refs, sorted by name (the advertisement preserves this order). */
  readonly refs: ReadonlyArray<RefRecord>;
}

/**
 * Inputs to the fetch closure computation (implemented over the commit graph
 * in `src/Git/Store/Closure.ts`).
 */
export interface ClosureRequest {
  /** Requested tips (from `want` lines). */
  readonly wants: ReadonlyArray<Oid>;
  /**
   * Common commits negotiated with the client (the ACKed haves). The walk
   * stops at these boundaries.
   */
  readonly haves: ReadonlyArray<Oid>;
  /** Depth bound from `deepen <n>`, when the client requested a shallow fetch. */
  readonly depth?: number | undefined;
  /** The client's existing shallow tips (additional walk boundaries). */
  readonly clientShallow: ReadonlyArray<Oid>;
  /**
   * The REPO's own shallow boundary (commits whose parents were never
   * ingested — a depth-limited import). These never expand in any walk and
   * always surface as `shallow <oid>` lines when included in a pack, so
   * clones of a shallow repo are themselves shallow (and fsck-clean).
   */
  readonly repoShallow?: ReadonlyArray<Oid> | undefined;
}

/**
 * The result of a closure computation: the pack manifest plus the shallow
 * boundary bookkeeping for the response's shallow section.
 */
export interface ClosureResult {
  /**
   * Every object to pack (commits + trees + blobs + tags), each exactly once.
   * Materialized before streaming so the pack header count is known upfront.
   */
  readonly entries: ReadonlyArray<ManifestEntry>;
  /** Commits that became shallow boundaries (`shallow <oid>` lines). */
  readonly shallow: ReadonlyArray<Oid>;
  /**
   * Previously-shallow client tips that are now complete
   * (`unshallow <oid>` lines).
   */
  readonly unshallow: ReadonlyArray<Oid>;
}

/**
 * Computes the object closure for a fetch: BFS from wants over the commit
 * graph stopping at haves (generation-bounded), depth-bounded when shallow,
 * plus the full tree/blob closure of the frontier commits.
 */
export interface ClosureSource {
  readonly commitClosure: (
    request: ClosureRequest,
  ) => Effect.Effect<ClosureResult, StoreError>;
}
