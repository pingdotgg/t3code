/**
 * The per-repo Durable Object (DESIGN.md §2, §3.4, §3.6, §8).
 *
 * One DO per repo, addressed by `getByName(repoId)` (a ULID — never
 * `owner/name`, so renames never move data). The DO owns refs, the object
 * index and loose bytes, tokens, the commit graph, push staging, and the
 * alarm jobs (import / fork / delete-purge / staging-GC). It runs the git
 * v0 wire protocol in its `fetch` handler — advertisement, upload-pack,
 * receive-pack — because every byte those need lives in this DO's SQLite.
 *
 * NOTE: the protocol *choreography* (advertisement builder, request
 * parsers, pack writer/parser) is implemented in this file against the
 * pure codec primitives in `src/Git/Protocol/` (`Pkt`, `Sideband`, `ObjectCodec`,
 * `Delta`, `Zlib`, `Store`). DESIGN.md places these in
 * `src/git/{Advertise,UploadPack,ReceivePack,PackParser,PackWriter}.ts`;
 * they live here (exported) until the git-layer split lands — moving them
 * is a mechanical extraction.
 *
 * ### Wire endpoints
 * The Worker proxies these untouched to `stub.fetch`:
 * **Example:** Routes served by this DO's fetch handler
 * ```
 * GET  /:owner/:repo[.git]/info/refs?service=git-(upload|receive)-pack
 * POST /:owner/:repo[.git]/git-upload-pack
 * POST /:owner/:repo[.git]/git-receive-pack
 * ```
 */
import * as Cloudflare from "../Cloudflare/index.ts";
import type { HttpEffect } from "../Http.ts";
import { RuntimeContext } from "../RuntimeContext.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import {
  BranchMissing,
  MergeConflict,
  NoMergeBase,
  NothingToMerge,
  ObjectNotFound,
  PullExists,
  PullNotFound,
  PullStateConflict,
  ReadOnlyRepo,
  RefConflict,
  RefNotFound,
  RepoNotFound,
  ValidationError,
  WrongObjectType,
  type Oid as ApiOid,
  type RepoStatus,
} from "./Api.ts";
import { applyDelta } from "./Protocol/Delta.ts";
import * as PackParser from "./Protocol/PackParser.ts";
import type { RandomAccess } from "./Protocol/PackParser.ts";
import {
  bytesToHex,
  concatBytes,
  decodeOfsDeltaOffset,
  decodeTypeSize,
  encodeCommit,
  encodeTypeSize,
  hashObject,
  isDeltaType,
  isOid,
  makeSha1,
  ObjectType,
  objectTypeName,
  parseCommit,
  parseTag,
  parseTree,
  treeEntryKind,
  utf8Encode,
  ZERO_OID,
  type ObjectTypeName,
  type Oid,
} from "./Protocol/ObjectCodec.ts";
import {
  decodePktLines,
  errPkt,
  flushPkt,
  pktPayloadText,
  pktText,
  readPktLineAt,
  type PktLine,
} from "./Protocol/Pkt.ts";
import {
  progressMessage,
  pumpPackBody,
  sidebandFrames,
} from "./Protocol/Sideband.ts";
import {
  StoreError,
  type ManifestEntry,
  type ObjectSource,
} from "./Protocol/Store.ts";
import {
  applyTreeChanges,
  conflictingPaths,
  diffTrees,
  type DiffEntryData,
} from "./Protocol/TreeDiff.ts";
import * as Zlib from "./Protocol/Zlib.ts";
import { runImport, type ImportSource } from "./Jobs/Import.ts";
import { runForkJob, snapshotStream, type SnapshotChunk } from "./Jobs/Fork.ts";
import { bundleCovers, runBundleJob, type BundleInfo } from "./Jobs/Bundle.ts";
import {
  runCompactJob,
  runGeometricMergeJob,
  shouldCompact,
} from "./Jobs/Compact.ts";
import { headKey, incomingKey, packKeyOf, wirePackId } from "./Store/Keys.ts";
import { encodeHeadSnapshot, type HeadSnapshot } from "./Store/HeadSnapshot.ts";
import { blobRandomAccess, sliceRandomAccess } from "./Store/PackSource.ts";
import { SPILL_PART_BYTES } from "./Store/IncomingBody.ts";
import type { BlobMultipart, UploadedPart } from "./BlobStore.ts";
import type { StreamingFeeder } from "./Store/StreamingSource.ts";
import {
  BACKPRESSURE_BYTES,
  makeStreamingSource,
  RETAIN_BYTES,
} from "./Store/StreamingSource.ts";
import {
  Hasher,
  type HasherShape,
  type HashPartResult,
} from "./Hasher/Hasher.ts";
import * as PartialScan from "./Protocol/PartialScan.ts";
import type { ScanResult } from "./Protocol/PartialScan.ts";
import type {
  DeltaBase,
  DeltaJob,
  UnresolvedDelta,
} from "./Protocol/PartialScan.ts";
import { BlobStore, type BlobStoreShape } from "./BlobStore.ts";
import { runPurgeJob } from "./Jobs/Purge.ts";
import { RegistryStore, ulid } from "./RegistryObject.ts";
import { decodeStagedBatch } from "./PushWire.ts";
import { computeClosure } from "./Store/Closure.ts";
import {
  makeObjectStore,
  MAX_OBJECT_SIZE,
  type ObjectStore,
  type StagedObject,
  LIVE_OBJECTS,
} from "./Store/ObjectStore.ts";
import type * as cf from "@cloudflare/workers-types";
import {
  initRepoSchema,
  makeSqlClient,
  type JobRow,
  type PullRow,
  type RefRow,
} from "./Store/Sql.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pushes up to this size are ingested straight from memory; larger ones are
 * parked in R2 and parsed from there (DESIGN.md §3.6). A **buffering
 * threshold, not a limit** — a push larger than this is no longer rejected.
 *
 * The spill threshold of the streaming receive (`receiveWireBody`): bodies
 * up to this size are buffered and parsed from memory (the fast path, at
 * 50 MiB the bound v1 validated for a 128 MB isolate); larger bodies are
 * never materialized — they stream into an R2 multipart upload as they
 * arrive and are parsed back through bounded windows.
 *
 * Measured on the 38 MiB alchemy-repo push: ~20 s in memory, ~37 s through
 * R2. The R2 path costs about 2x, and is unbounded — the full 67 MiB
 * alchemy history (44k objects) pushed in 92 s.
 */
export const MAX_PACK_BYTES = 4 * 1024 * 1024;
// 4 MiB (was 50, then 24): with promoted wire packs (DESIGN §22.5) the
// spilled path is the FAST one — it never writes blob bytes to SQLite, so
// staging and the staged→live flip cost milliseconds instead of seconds
// (a 5.7 MiB in-memory push spent 6 s in finalize on production; a 40 MiB
// spilled one 0.7 s). Only genuinely small pushes stay in memory.
// 24 MiB, down from the 50 MiB v1 validated with ONE active repo: instances
// of this class share an isolate, so the in-memory pack, the ingest's
// resolved-content LRU (20 MiB) and staging batch (8 MiB) sit beside every
// other active repo's working set. DESIGN §22.4 records the OOM that
// motivated it; the R2 path costs ~2x on the bytes above the threshold.

/** Objects staged per SQL transaction during ingest (DESIGN.md §16.6). */
/** Bytes per hasher part — the spill part size, so a part is one R2 part (DESIGN §22.7). */
export const HASH_PART_BYTES = 4 * 1024 * 1024;
/** Hasher calls in flight per push (DESIGN §22.8). */
export const HASH_CONCURRENCY = 8;
// 4 MiB (was 8): the hasher chain is sequential (each part needs the
// previous part's boundary), so a smaller part shortens both the tail after
// the upload ends and the granularity at which the upload can run ahead.

export const STAGE_BATCH_OBJECTS = 2048;
// 2048 (was 256): measured on production, staging cost tracked the number
// of transaction COMMITs (~100 ms each), not rows — 61 commits for a
// 15.6k-object push. Objects average a few KiB, so 2048 stays well under
// STAGE_BATCH_BYTES; the byte cap still bounds memory for large objects.

/** Byte budget per staging batch, so a batch of large blobs stays bounded. */
export const STAGE_BATCH_BYTES = 8 * 1024 * 1024;

// The tree-diff caps (`MAX_DIFF_FILES`, `MAX_DIFF_TREE_READS`) live with
// the pure walk in `Protocol/TreeDiff.ts`; re-exported here alongside the other
// serving-plane bounds.
export { MAX_DIFF_FILES, MAX_DIFF_TREE_READS } from "./Protocol/TreeDiff.ts";

/** Max commits popped by the merge-base paint walk. */
export const MAX_COMPARE_WALK = 10_000;

/** Max commits returned in a Comparison's `commits` array. */
export const MAX_COMPARE_COMMITS = 250;

/**
 * Max commits popped by the PR live-field walk (`getPull`). Saturation
 * makes the numeric detail fields `null` (reason `"unknown"`); merge still
 * works because {@link MAX_PULL_MERGE_WALK} gives the merge path a deeper
 * budget.
 */
export const MAX_PULL_WALK = 5_000;

/** Deeper walk budget for `mergePull` (needs only reachability + one base). */
export const MAX_PULL_MERGE_WALK = 50_000;

/** Conflicting paths reported on a `MergeConflict` (the set may be larger). */
export const MAX_CONFLICT_PATHS = 20;

/** Agent string advertised on the wire. */
export const GIT_AGENT = "git-service/1";

/** How long a push waits for ingest memory before answering 503. */
export const PUSH_WAIT_TIMEOUT = "30 seconds";

/**
 * Memory the Repo DO lends to concurrent push ingests, in MiB — one
 * permit per MiB (DESIGN.md §2.1).
 *
 * The semaphore exists for MEMORY, not correctness: a DO is
 * single-threaded, but its input gate is only closed across *storage*
 * awaits, and receive-pack awaits the network and blob storage — so two
 * pushes genuinely interleave. Correctness across that interleave is
 * already handled by data scoping (`staged_push = pushId`, and every
 * read filtering `staged_push IS NULL`) plus a synchronous
 * `transactionSync` finalize. What is left is that two concurrent
 * 50 MiB buffers would exhaust the 128 MB isolate.
 *
 * Bounding the resource rather than the count is what lets pushes to
 * different branches proceed together: a normal push is kilobytes and
 * takes one permit, so it no longer queues behind a large one.
 */
export const PUSH_MEMORY_BUDGET_MB = 64;

let sharedPushGate: Semaphore.Semaphore | undefined;
/**
 * The push-admission semaphore, ONE per isolate (DESIGN §21.2, §22.4). DO
 * instances of a class share an isolate, so a per-instance gate would let
 * N repos each admit a full budget's worth of concurrent pushes.
 */
export const isolatePushGate: Effect.Effect<Semaphore.Semaphore> =
  Effect.suspend(() =>
    sharedPushGate === undefined
      ? Semaphore.make(PUSH_MEMORY_BUDGET_MB).pipe(
          Effect.tap((gate) =>
            Effect.sync(() => {
              sharedPushGate = gate;
            }),
          ),
        )
      : Effect.succeed(sharedPushGate),
  );

/**
 * Permits a push must reserve: its buffered ceiling in MiB. A body
 * larger than {@link MAX_PACK_BYTES} spills to blob storage instead of
 * growing in memory, so that is the cap; an absent `content-length`
 * (chunked upload) is charged the same worst case.
 */
export const pushPermitsFor = (contentLength: number | undefined): number => {
  const mib = (bytes: number) => Math.ceil(bytes / (1024 * 1024));
  // What a push can hold at once, in MiB — never its body. An unknown
  // length is treated as spilled. Memory safety beats concurrency: on a
  // 64 MiB budget that admits one large push per isolate alongside small ones.
  // Streaming (DESIGN §22.6–7): the feeder retains RETAIN_BYTES behind the
  // pump and buffers BACKPRESSURE_BYTES ahead of it, plus one staging batch.
  const spilled = mib(RETAIN_BYTES + BACKPRESSURE_BYTES + STAGE_BATCH_BYTES);
  // In memory the caches cannot outgrow what the (small) body can inflate
  // to, so charge the body twice (compressed + inflated) plus one for the
  // batch, rather than the caches' ceilings.
  const permits =
    contentLength === undefined ||
    !Number.isFinite(contentLength) ||
    contentLength > MAX_PACK_BYTES
      ? spilled
      : mib(Math.max(contentLength, 0)) * 2 + 1;
  return Math.max(1, Math.min(PUSH_MEMORY_BUDGET_MB, permits));
};

/** How long crashed push staging survives before the GC alarm reaps it. */
export const STAGING_TTL_MS = 24 * 60 * 60 * 1000;

/** The realm sent on wire 401s. */
export const WWW_AUTHENTICATE = 'Basic realm="git-service"' as const;

/**
 * Worker↔DO headers for the clone-bundle splice (DESIGN.md §11): the DO
 * answers an eligible clone with these *instead of* the pack, and the
 * Worker streams the named R2 object to the client. Only
 * {@link BUNDLE_HASH_HEADER} is kept on the client-visible response, as
 * observable proof the fast path served the clone.
 */
export const BUNDLE_KEY_HEADER = "x-git-bundle-key" as const;
export const BUNDLE_HASH_HEADER = "x-git-bundle" as const;
export const BUNDLE_COUNT_HEADER = "x-git-bundle-count" as const;
export const BUNDLE_SIDEBAND_HEADER = "x-git-bundle-sideband" as const;

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A push pack failed to ingest (malformed, oversize, checksum mismatch,
 * missing thin base, delta error). Reported in-band as `unpack <reason>` +
 * per-ref `ng` — never as an HTTP error.
 */
export class PackIngestError extends Schema.TaggedError<PackIngestError>()(
  "PackIngestError",
  { reason: Schema.String },
) {}

/**
 * A syntactically valid request that the v0 grammar does not allow
 * (missing wants, malformed command lines, unsupported deepen flavors).
 * Answered with an `ERR` pkt.
 */
export class WireProtocolError extends Schema.TaggedError<WireProtocolError>()(
  "WireProtocolError",
  { reason: Schema.String },
) {}

// ─────────────────────────────────────────────────────────────────────────────
// RPC data shapes (plain serializable data — no Schema classes over RPC)
// ─────────────────────────────────────────────────────────────────────────────

/** Repo metadata as stored in the `config` table. */
export interface RepoMetaData {
  readonly repoId: string;
  readonly owner: string;
  readonly name: string;
  readonly defaultBranch: string;
  readonly description: string | null;
  readonly readOnly: boolean;
  /** Anyone can read/clone without a token (GitHub public-repo model). */
  readonly public: boolean;
  readonly forkOf: string | null;
  readonly status: RepoStatus;
  readonly createdAt: number;
  /** Object storage breakdown (DESIGN.md §12.1). */
  readonly objects: ObjectStatsData;
  /** Server-side timing of the last push (DESIGN.md §19 phase 0). */
  readonly lastPush: PushStatsData | null;
}

/** `beginPush` input: the parsed ref commands (DESIGN §22.10). */
export interface BeginPushInput {
  readonly commands: ReadonlyArray<RefCommand>;
}
/** `beginPush` outcome. `denied` is reported per ref (`ng <ref> <reason>`). */
export type BeginPushResult =
  | { readonly _tag: "ok"; readonly pushId: string }
  | { readonly _tag: "denied"; readonly reason: string };
/** One ref's outcome in a push report. */
export interface PushRefResult {
  readonly ref: string;
  readonly ok: boolean;
  readonly reason?: string | undefined;
}
/** `commitPush` input: what the Worker-side ingest learned (DESIGN §22.10). */
export interface CommitPushInput {
  readonly pushId: string;
  readonly commands: ReadonlyArray<RefCommand>;
  readonly atomic: boolean;
  readonly commits: ReadonlyArray<StagedCommitInfo>;
  readonly referenced: ReadonlyArray<Oid>;
  readonly referencedParents: ReadonlyArray<Oid>;
  /** Rows staged as references into the wire pack (it must then outlive the push). */
  readonly promoted: number;
  readonly stats: {
    readonly objects: number;
    readonly bytes: number;
    readonly ingestMs: number;
    readonly stageMs: number;
    readonly phases: Record<string, number> | undefined;
  };
}
/** `commitPush` outcome: the `unpack` line and per-ref results. */
export interface CommitPushResult {
  readonly unpack: string;
  readonly results: ReadonlyArray<PushRefResult>;
}

/** Server-side push timing — see the REST `PushStats` schema. */
export interface PushStatsData {
  readonly objects: number;
  readonly bytes: number;
  readonly ingestMs: number;
  readonly stageMs: number;
  readonly connectivityMs: number;
  readonly finalizeMs: number;
  readonly totalMs: number;
  /** Ingest split by phase (ms) — see the REST `PushStats.phases` caveat. */
  readonly phases?: Record<string, number> | undefined;
}

/** Where a repo's objects live — see the REST `ObjectStats` schema. */
export interface ObjectStatsData {
  /** Blobs still in SQLite rows, awaiting compaction into an R2 pack. */
  readonly loose: number;
  /** Commits, trees and tags: always SQLite rows (never packed). */
  readonly resident: number;
  /** Blobs in R2 packs. */
  readonly packed: number;
  readonly r2: number;
  readonly bytes: number;
}

/** Patch accepted by {@link GitRepoShape.updateRepoMeta}. */
export interface RepoMetaPatch {
  readonly description?: string | null | undefined;
  /** Must resolve to an existing branch. */
  readonly defaultBranch?: string | undefined;
  readonly readOnly?: boolean | undefined;
  /** Anyone can read/clone without a token when `true`. */
  readonly public?: boolean | undefined;
}

/** One ref (peeled target present for annotated tags). */
export interface RefData {
  readonly name: string;
  readonly oid: string;
  readonly peeled?: string | undefined;
}

/** Result of {@link GitRepoShape.listRefs}. */
export interface RefsPage {
  /** The default branch's full ref name, `null` on an unborn repo. */
  readonly head: string | null;
  readonly refs: ReadonlyArray<RefData>;
}

/** Input of {@link GitRepoShape.initRepo} (also fork/import bootstrap). */
export interface InitRepoInput {
  readonly repoId: string;
  readonly owner: string;
  readonly name: string;
  readonly defaultBranch: string;
  readonly description: string | null;
  readonly readOnly: boolean;
  /** Anyone can read/clone without a token when `true`. */
  readonly public: boolean;
  readonly forkOf: string | null;
}

/** Result of init/fork/import bootstrap: the meta + a bootstrap token. */
export interface InitRepoResult {
  readonly meta: RepoMetaData;
}

/** Input of {@link GitRepoShape.updateRef}. */
export interface UpdateRefInput {
  readonly name: string;
  readonly newOid: string;
  /**
   * CAS token: `string` = must currently equal; `null` = must not exist;
   * absent = unconditional.
   */
  readonly expectedOid?: string | null | undefined;
}

/** Input of {@link GitRepoShape.removeRef}. */
export interface RemoveRefInput {
  readonly name: string;
  readonly expectedOid?: string | undefined;
}

/** Input of {@link GitRepoShape.readObject}. */
export interface ReadObjectInput {
  readonly oid: string;
  /** When set, a different actual type fails with `WrongObjectType`. */
  readonly expect?: ObjectTypeName | undefined;
}

/** A fully-read object (content inflated, ≤ 64 MiB by the ingest cap). */
export interface ObjectData {
  readonly oid: string;
  readonly type: ObjectTypeName;
  readonly size: number;
  readonly content: Uint8Array;
}

/** One commit for the REST read surface. */
export interface CommitData {
  readonly oid: string;
  readonly tree: string;
  readonly parents: ReadonlyArray<string>;
  readonly author: SignatureData;
  readonly committer: SignatureData;
  readonly message: string;
}

/** An author/committer signature. */
export interface SignatureData {
  readonly name: string;
  readonly email: string;
  readonly date: number;
  readonly tz: string;
}

/** Input of {@link GitRepoShape.readCommitLog}. */
export interface CommitLogInput {
  /** Refname or 40-hex oid; default = HEAD (the default branch). */
  readonly ref?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

/** One page of {@link GitRepoShape.readCommitLog}. */
export interface CommitLogPage {
  readonly items: ReadonlyArray<CommitData>;
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

// `DiffEntryData` (one changed file) is defined next to the pure walk in
// `Protocol/TreeDiff.ts`; re-exported here with the other RPC data shapes.
export type { DiffEntryData } from "./Protocol/TreeDiff.ts";

/** Result of {@link GitRepoShape.readCommitDiff}. */
export interface CommitDiffData {
  readonly oid: string;
  readonly parent: string | null;
  readonly files: ReadonlyArray<DiffEntryData>;
  readonly truncated: boolean;
}

/** Input of {@link GitRepoShape.compareCommits}. */
export interface CompareInput {
  /** Refname or 40-hex oid. */
  readonly base: string;
  readonly head: string;
}

/** Result of {@link GitRepoShape.compareCommits}. */
export interface CompareData {
  readonly base: string;
  readonly head: string;
  readonly mergeBase: string;
  readonly aheadBy: number;
  readonly behindBy: number;
  readonly commits: ReadonlyArray<CommitData>;
  readonly commitsTruncated: boolean;
  readonly files: ReadonlyArray<DiffEntryData>;
  readonly filesTruncated: boolean;
}

/** Input of {@link GitRepoShape.readFileAtPath}. */
export interface ReadFileInput {
  /** Refname or 40-hex oid; default = HEAD. */
  readonly ref?: string | undefined;
  /** Slash-separated path inside the tree. */
  readonly path: string;
}

/** A file read via tree walk. */
export interface FileData {
  readonly oid: string;
  /** Octal mode string, e.g. `100644`. */
  readonly mode: string;
  readonly size: number;
  readonly content: Uint8Array;
}

/** One pull-request row (see the REST `Pull` schema). */
export interface PullData {
  readonly number: number;
  readonly title: string;
  readonly body: string | null;
  /** Full base ref name, e.g. `refs/heads/main`. */
  readonly baseRef: string;
  /** Full head ref name, e.g. `refs/heads/feature`. */
  readonly headRef: string;
  readonly state: "open" | "closed" | "merged";
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly mergedAt: number | null;
  /** FF: the head tip; the merge commit otherwise. Set iff state=merged. */
  readonly mergeCommit: string | null;
}

/** Detail = row + live compare fields (`null` = uncomputable, see REST docs). */
export interface PullDetailData extends PullData {
  readonly baseOid: string | null;
  readonly headOid: string | null;
  readonly mergeBase: string | null;
  readonly aheadBy: number | null;
  readonly behindBy: number | null;
  readonly mergeable: boolean | null;
  readonly mergeableReason:
    | "ff"
    | "merge-commit"
    | "conflict"
    | "up-to-date"
    | "unknown"
    | null;
}

/** Input of {@link GitRepoShape.createPull}. */
export interface CreatePullInput {
  readonly title: string;
  readonly body?: string | undefined;
  /** Short or full branch name; normalized to `refs/heads/…` here. */
  readonly base: string;
  readonly head: string;
}

/** Input of {@link GitRepoShape.listPulls}. */
export interface ListPullsInput {
  readonly state?: "open" | "closed" | "merged" | "all" | undefined;
  /** Last-seen PR number as a string (keyset pagination, newest first). */
  readonly cursor?: string | undefined;
  /** Default 20, max 100. */
  readonly limit?: number | undefined;
}

/** One page of {@link GitRepoShape.listPulls}. */
export interface PullsPage {
  readonly items: ReadonlyArray<PullData>;
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

/** Input of {@link GitRepoShape.updatePull}. */
export interface UpdatePullInput {
  readonly number: number;
  readonly title?: string | undefined;
  /** `null` clears the body. */
  readonly body?: string | null | undefined;
  readonly state?: "open" | "closed" | undefined;
}

/** Input of {@link GitRepoShape.mergePull}. */
export interface MergePullInput {
  readonly number: number;
  /** Merge-commit message; ignored on fast-forward. */
  readonly message?: string | undefined;
  /** Race guard: fail RefConflict when the head tip moved since inspection. */
  readonly expectedHeadOid?: string | undefined;
  /** Race guard for application inspection of the base branch. */
  readonly expectedBaseOid?: string | undefined;
}

/** Result of {@link GitRepoShape.mergePull}. */
export interface MergePullResult {
  readonly method: "ff" | "merge-commit";
  /** The oid the base ref now points at. */
  readonly oid: string;
  readonly pull: PullData;
}

/** Input of {@link GitRepoShape.startImport}. */
export interface StartImportInput extends InitRepoInput {
  readonly source: ImportSource;
}

/** Input of {@link GitRepoShape.startFork}. */
export interface StartForkInput extends InitRepoInput {
  readonly parentRepoId: string;
}

/** The common auth+repo error union of most RPC methods. */
export type RepoAuthError = RepoNotFound | StoreError;

/**
 * The Repo DO's typed RPC surface. All methods are `RuntimeContext`-colored
 * (callable only through a stub / inside the deployed Worker). Note: no
 * method may be named `delete` (Cloudflare stub proxy reserves it).
 */
export interface GitRepoShape {
  /** Seeds config (repo create). */
  readonly initRepo: (
    input: InitRepoInput,
  ) => Effect.Effect<InitRepoResult, StoreError, RuntimeContext>;
  /** Seeds config with `status: importing`, arms the import alarm job. */
  readonly startImport: (
    input: StartImportInput,
  ) => Effect.Effect<InitRepoResult, StoreError, RuntimeContext>;
  /** Seeds config with `status: forking`, arms the fork alarm job. */
  readonly startFork: (
    input: StartForkInput,
  ) => Effect.Effect<InitRepoResult, StoreError, RuntimeContext>;
  /** Flips `status: deleting` and arms the purge alarm job. */
  /**
   * Arms a compaction run now (admin): loose object bytes are moved into an
   * immutable R2 pack by the alarm (DESIGN.md §12.1). Normally armed
   * automatically by the post-push size check.
   */
  readonly startCompact: () => Effect.Effect<
    void,
    RepoAuthError,
    RuntimeContext
  >;
  readonly startPurge: () => Effect.Effect<void, RepoAuthError, RuntimeContext>;
  readonly getRepoMeta: () => Effect.Effect<
    RepoMetaData,
    RepoAuthError,
    RuntimeContext
  >;
  /** Repo metadata for the Worker's own bookkeeping. */
  readonly readMeta: () => Effect.Effect<
    RepoMetaData,
    RepoNotFound | StoreError,
    RuntimeContext
  >;
  readonly updateRepoMeta: (
    patch: RepoMetaPatch,
  ) => Effect.Effect<RepoMetaData, RepoAuthError | RefNotFound, RuntimeContext>;
  readonly listRefs: (
    prefix?: string | undefined,
  ) => Effect.Effect<RefsPage, RepoAuthError, RuntimeContext>;
  readonly getRef: (
    name: string,
  ) => Effect.Effect<RefData, RepoAuthError | RefNotFound, RuntimeContext>;
  readonly updateRef: (
    input: UpdateRefInput,
  ) => Effect.Effect<
    RefData,
    RepoAuthError | RefConflict | ObjectNotFound | ReadOnlyRepo,
    RuntimeContext
  >;
  readonly removeRef: (
    input: RemoveRefInput,
  ) => Effect.Effect<
    void,
    RepoAuthError | RefNotFound | RefConflict | ReadOnlyRepo,
    RuntimeContext
  >;
  readonly readObject: (
    input: ReadObjectInput,
  ) => Effect.Effect<
    ObjectData,
    RepoAuthError | ObjectNotFound | WrongObjectType,
    RuntimeContext
  >;
  readonly readCommitLog: (
    input: CommitLogInput,
  ) => Effect.Effect<
    CommitLogPage,
    RepoAuthError | RefNotFound,
    RuntimeContext
  >;
  /**
   * The changed-file list of a commit vs its FIRST parent (empty tree for
   * a root commit) — see the REST `diff` endpoint.
   */
  readonly readCommitDiff: (input: {
    readonly oid: string;
  }) => Effect.Effect<
    CommitDiffData,
    RepoAuthError | ObjectNotFound | WrongObjectType,
    RuntimeContext
  >;
  /**
   * Three-dot comparison of two revisions: merge base, ahead/behind
   * counts, head-side commits, and the mergeBase..head file diff — see
   * the REST `compare` endpoint.
   */
  readonly compareCommits: (
    input: CompareInput,
  ) => Effect.Effect<
    CompareData,
    | RepoAuthError
    | RefNotFound
    | ObjectNotFound
    | WrongObjectType
    | NoMergeBase,
    RuntimeContext
  >;
  readonly readFileAtPath: (
    input: ReadFileInput,
  ) => Effect.Effect<
    FileData,
    RepoAuthError | RefNotFound | ObjectNotFound,
    RuntimeContext
  >;
  /** Opens a pull request (same-repo branches, `write` scope). */
  readonly createPull: (
    input: CreatePullInput,
  ) => Effect.Effect<
    PullData,
    RepoAuthError | BranchMissing | PullExists | ValidationError,
    RuntimeContext
  >;
  /** Lists PRs newest-first with keyset pagination (`read` scope). */
  readonly listPulls: (
    input: ListPullsInput,
  ) => Effect.Effect<PullsPage, RepoAuthError, RuntimeContext>;
  /** Reads one PR with live compare fields recomputed from current tips. */
  readonly getPull: (
    number: number,
  ) => Effect.Effect<
    PullDetailData,
    RepoAuthError | PullNotFound,
    RuntimeContext
  >;
  /** Patches title/body, or closes/reopens via `state` (`write` scope). */
  readonly updatePull: (
    input: UpdatePullInput,
  ) => Effect.Effect<
    PullData,
    RepoAuthError | PullNotFound | PullStateConflict,
    RuntimeContext
  >;
  /**
   * Merges an open PR: fast-forward when possible, else a two-parent merge
   * commit iff the three-way tree merge is trivial (no path changed on both
   * sides vs the merge base). Conflicts are a typed 409 — the server never
   * writes conflict markers.
   */
  readonly mergePull: (
    input: MergePullInput,
  ) => Effect.Effect<
    MergePullResult,
    | RepoAuthError
    | PullNotFound
    | PullStateConflict
    | BranchMissing
    | NothingToMerge
    | MergeConflict
    | RefConflict
    | ReadOnlyRepo,
    RuntimeContext
  >;
  /**
   * Streams a row snapshot for a fork (DESIGN.md §2.3 Fork). Internal —
   * called only by a sibling Repo DO's fork alarm job; never routed from
   * the Worker.
   */
  readonly snapshotRows: () => Stream.Stream<SnapshotChunk, StoreError>;
  /**
   * Push, phase 1 (DESIGN §22.10): authorize the parsed commands and open
   * a staging push. The Worker then streams the pack through the hasher
   * fan-out and the spill, staging rows with `stagePush`.
   */
  readonly beginPush: (
    input: BeginPushInput,
  ) => Effect.Effect<
    BeginPushResult,
    RepoNotFound | StoreError,
    RuntimeContext
  >;
  /** Push, phase 2: stage one batch of rows (see `PushWire.ts`). */
  readonly stagePush: (
    pushId: string,
    batch: Uint8Array,
  ) => Effect.Effect<void, RepoNotFound | StoreError, RuntimeContext>;
  /** Abort uncommitted staging; false means committed data must be retained. */
  readonly abortPush: (
    pushId: string,
    packIds?: ReadonlyArray<string>,
  ) => Effect.Effect<boolean, RepoNotFound | StoreError, RuntimeContext>;
  /** Validate connectivity without moving refs. Commit repeats this check. */
  readonly validatePush: (
    input: CommitPushInput,
  ) => Effect.Effect<void, RepoNotFound | StoreError, RuntimeContext>;
  /** Read from this push's staging area and the live store only. */
  readonly readPreparedObject: (
    pushId: string,
    oid: Oid,
    maxBytes: number,
  ) => Effect.Effect<
    { readonly type: ObjectType; readonly content: Uint8Array } | undefined,
    RepoNotFound | StoreError,
    RuntimeContext
  >;
  /** A live object for thin-delta base resolution, or `undefined`. */
  readonly readPushBase: (
    oid: Oid,
  ) => Effect.Effect<
    { readonly type: ObjectType; readonly content: Uint8Array } | undefined,
    RepoNotFound | StoreError,
    RuntimeContext
  >;
  /**
   * Push, phase 3: connectivity over the staged rows, the commit-graph
   * rows, the transactional ref CAS, and post-commit bookkeeping.
   */
  readonly commitPush: (
    input: CommitPushInput,
  ) => Effect.Effect<
    CommitPushResult,
    RepoNotFound | StoreError,
    RuntimeContext
  >;
  /** The git wire protocol (info/refs, upload-pack). */
  readonly fetch: HttpEffect<Cloudflare.DurableObjectState | RuntimeContext>;
  /** Alarm job dispatcher (import / fork / purge / gc). */
  readonly alarm: (
    info?: Cloudflare.AlarmInvocationInfo,
  ) => Effect.Effect<void, never, RuntimeContext>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Protocol choreography — pure helpers (exported for tests / future split)
// ─────────────────────────────────────────────────────────────────────────────

/** Upload-pack capability list (DESIGN.md §4). */
export const uploadCapabilities = (defaultBranch: string): string =>
  `multi_ack_detailed no-done side-band-64k shallow ofs-delta agent=${GIT_AGENT} symref=HEAD:refs/heads/${defaultBranch} object-format=sha1`;

/** Receive-pack capability list (DESIGN.md §4). */
export const receiveCapabilities = (): string =>
  `report-status report-status-v2 delete-refs side-band-64k atomic ofs-delta object-format=sha1 agent=${GIT_AGENT}`;

/** The two smart-HTTP services. */
export type GitService = "git-upload-pack" | "git-receive-pack";

/**
 * Builds the v0 `info/refs` advertisement (with `# service=` prelude):
 * HEAD first with the capability line, refs sorted, annotated tags peeled
 * (`^{}` lines), zero-id `capabilities^{}` on an empty repo.
 */
export const buildAdvertisement = (options: {
  readonly service: GitService;
  readonly defaultBranch: string;
  /** Sorted by name; peeled targets included for annotated tags. */
  readonly refs: ReadonlyArray<RefData>;
}): Uint8Array => {
  const caps =
    options.service === "git-upload-pack"
      ? uploadCapabilities(options.defaultBranch)
      : receiveCapabilities();
  const parts: Array<Uint8Array> = [
    pktText(`# service=${options.service}`),
    flushPkt,
  ];
  const lines: Array<string> = [];
  const headRef = options.refs.find(
    (ref) => ref.name === `refs/heads/${options.defaultBranch}`,
  );
  if (options.service === "git-upload-pack" && headRef !== undefined) {
    lines.push(`${headRef.oid} HEAD`);
  }
  for (const ref of options.refs) {
    lines.push(`${ref.oid} ${ref.name}`);
    if (ref.peeled !== undefined) {
      lines.push(`${ref.peeled} ${ref.name}^{}`);
    }
  }
  if (lines.length === 0) {
    parts.push(pktText(`${ZERO_OID} capabilities^{}\0${caps}`));
  } else {
    lines.forEach((line, index) => {
      parts.push(index === 0 ? pktText(`${line}\0${caps}`) : pktText(line));
    });
  }
  parts.push(flushPkt);
  return concatBytes(parts);
};

/** A parsed v0 upload-pack request. */
export interface UploadPackRequest {
  readonly wants: ReadonlyArray<Oid>;
  readonly haves: ReadonlyArray<Oid>;
  readonly done: boolean;
  readonly depth: number | undefined;
  readonly clientShallow: ReadonlyArray<Oid>;
  readonly capabilities: ReadonlySet<string>;
}

/**
 * Parses a v0 upload-pack POST body (already gunzipped) into wants /
 * shallow / deepen / haves / done. Rejects `deepen-since` / `deepen-not` /
 * `filter` (not advertised) with {@link WireProtocolError}.
 */
export const parseUploadPackRequest = (
  pkts: ReadonlyArray<PktLine>,
): Effect.Effect<UploadPackRequest, WireProtocolError> =>
  Effect.suspend(() => {
    const wants: Array<Oid> = [];
    const haves: Array<Oid> = [];
    const clientShallow: Array<Oid> = [];
    let done = false;
    let depth: number | undefined;
    let capabilities: ReadonlySet<string> = new Set();

    for (const pkt of pkts) {
      if (pkt._tag !== "data") continue;
      const text = pktPayloadText(pkt.payload);
      if (text === "done") {
        done = true;
        continue;
      }
      if (text.startsWith("want ")) {
        let rest = text.slice(5);
        if (wants.length === 0) {
          const space = rest.indexOf(" ");
          if (space !== -1) {
            capabilities = new Set(
              rest
                .slice(space + 1)
                .split(" ")
                .filter(Boolean),
            );
            rest = rest.slice(0, space);
          }
        }
        if (!isOid(rest)) {
          return Effect.fail(
            new WireProtocolError({ reason: `malformed want line: ${text}` }),
          );
        }
        wants.push(rest);
        continue;
      }
      if (text.startsWith("have ")) {
        const oid = text.slice(5, 45);
        if (isOid(oid)) haves.push(oid);
        continue;
      }
      if (text.startsWith("shallow ")) {
        const oid = text.slice(8);
        if (!isOid(oid)) {
          return Effect.fail(
            new WireProtocolError({
              reason: `malformed shallow line: ${text}`,
            }),
          );
        }
        clientShallow.push(oid);
        continue;
      }
      if (text.startsWith("deepen ")) {
        const n = Number.parseInt(text.slice(7), 10);
        if (!Number.isInteger(n) || n <= 0) {
          return Effect.fail(
            new WireProtocolError({ reason: `malformed deepen line: ${text}` }),
          );
        }
        depth = n;
        continue;
      }
      if (text.startsWith("deepen-since ") || text.startsWith("deepen-not ")) {
        return Effect.fail(
          new WireProtocolError({
            reason: `${text.split(" ")[0]} is not supported`,
          }),
        );
      }
      if (text.startsWith("filter ")) {
        return Effect.fail(
          new WireProtocolError({ reason: "filter is not supported" }),
        );
      }
      // ignore unknown lines defensively
    }
    if (wants.length === 0) {
      return Effect.fail(
        new WireProtocolError({ reason: "upload-pack request has no wants" }),
      );
    }
    return Effect.succeed({
      wants,
      haves,
      done,
      depth,
      clientShallow,
      capabilities,
    });
  });

/** One receive-pack command (`<old> <new> <refname>`). */
export interface RefCommand {
  readonly oldOid: Oid;
  readonly newOid: Oid;
  readonly ref: string;
}

/** A parsed v0 receive-pack request head. */
export interface ReceivePackRequest {
  readonly commands: ReadonlyArray<RefCommand>;
  readonly capabilities: ReadonlySet<string>;
  /** Byte offset of the pack within the body (== length when no pack). */
  readonly packStart: number;
  /** True for git's bare-flush `http.postBuffer` probe. */
  readonly probe: boolean;
}

const REF_NAME_REGEX = /^refs\/[^\s~^:?*\[\\]+$/;

/**
 * Parses a v0 receive-pack POST body (already gunzipped): command
 * pkt-lines (first carries `\0caps`) up to the flush, leaving the raw pack
 * bytes at `packStart`. Detects the empty-flush probe (DESIGN.md §2.3
 * Push step 2).
 */
export const parseReceivePackRequest = (
  body: Uint8Array,
): Effect.Effect<ReceivePackRequest, WireProtocolError> =>
  Effect.suspend(() => {
    const commands: Array<RefCommand> = [];
    let capabilities: ReadonlySet<string> = new Set();
    let pos = 0;
    let first = true;

    for (;;) {
      if (pos >= body.length) {
        // Body ended without a flush: only legal as the bare probe of an
        // entirely empty body.
        if (commands.length === 0 && pos === 0) {
          return Effect.succeed({
            commands: [],
            capabilities,
            packStart: body.length,
            probe: true,
          });
        }
        return Effect.fail(
          new WireProtocolError({
            reason: "receive-pack request ended before flush",
          }),
        );
      }
      const r = readPktLineAt(body, pos);
      if (r._tag === "incomplete" || r._tag === "invalid") {
        return Effect.fail(
          new WireProtocolError({
            reason:
              r._tag === "invalid"
                ? r.reason
                : "truncated receive-pack request",
          }),
        );
      }
      pos = r.next;
      if (r.pkt._tag === "flush") {
        return Effect.succeed({
          commands,
          capabilities,
          packStart: pos,
          probe: commands.length === 0 && pos >= body.length,
        });
      }
      if (r.pkt._tag !== "data") continue;
      let text = pktPayloadText(r.pkt.payload);
      if (first) {
        const nul = text.indexOf("\0");
        if (nul !== -1) {
          capabilities = new Set(
            text
              .slice(nul + 1)
              .split(" ")
              .filter(Boolean),
          );
          text = text.slice(0, nul);
        }
        first = false;
      }
      const oldOid = text.slice(0, 40);
      const newOid = text.slice(41, 81);
      const ref = text.slice(82);
      if (
        !isOid(oldOid) ||
        !isOid(newOid) ||
        text[40] !== " " ||
        text[81] !== " " ||
        !REF_NAME_REGEX.test(ref)
      ) {
        return Effect.fail(
          new WireProtocolError({ reason: `malformed command line: ${text}` }),
        );
      }
      commands.push({ oldOid, newOid, ref });
    }
  });

/** The 12-byte pack header: `PACK`, version 2, entry count. */
export const packHeader = (count: number): Uint8Array => {
  const out = new Uint8Array(12);
  out.set(utf8Encode("PACK"), 0);
  const view = new DataView(out.buffer);
  view.setUint32(4, 2);
  view.setUint32(8, count);
  return out;
};

/**
 * The §3.5 no-delta pack emitter: header + per-entry
 * `varint(type,size) + stored zdata` (verbatim — zero compression CPU) +
 * incremental SHA-1 trailer. Constant memory; the manifest is already
 * materialized so the count is known upfront.
 */
export const packStream = (
  entries: ReadonlyArray<ManifestEntry>,
  objects: ObjectSource,
): Stream.Stream<Uint8Array, StoreError> =>
  Stream.suspend(() => {
    const sha = makeSha1();
    const tap = (bytes: Uint8Array): Uint8Array => {
      sha.update(bytes);
      return bytes;
    };
    const header = Stream.sync(() => tap(packHeader(entries.length)));
    const body = packEntryStream(entries, objects).pipe(Stream.map(tap));
    const trailer = Stream.sync(() => sha.digest());
    return header.pipe(Stream.concat(body), Stream.concat(trailer));
  });

/**
 * The entry stream alone — no header, no trailer. Because entries are
 * stored non-delta (`varint(type,size) + zdata`), entry streams from
 * different sources concatenate into one valid pack under a rewritten
 * header and a fresh trailer. That is what lets a clone be served as
 * "bundle bytes + a small delta" (DESIGN.md §21.2), and it is the same
 * property geometric pack merging relies on.
 */
export const packEntryStream = (
  entries: ReadonlyArray<ManifestEntry>,
  objects: ObjectSource,
): Stream.Stream<Uint8Array, StoreError> =>
  objects.packEntries !== undefined
    ? objects.packEntries(entries)
    : Stream.fromIterable(entries).pipe(
        Stream.flatMap((entry) =>
          Stream.sync(() => encodeTypeSize(entry.type, entry.size)).pipe(
            Stream.concat(objects.readZData(entry.oid)),
          ),
        ),
      );

// ─────────────────────────────────────────────────────────────────────────────
// Pack ingest (DESIGN.md §3.6) — buffered v1, RandomAccess seam is the buffer
// ─────────────────────────────────────────────────────────────────────────────

/** A commit staged by an ingest, with what the commit graph needs. */
export interface StagedCommitInfo {
  readonly oid: Oid;
  readonly tree: Oid;
  readonly parents: ReadonlyArray<Oid>;
  readonly commitTime: number;
}

/** The result of a successful pack ingest. */
export interface IngestResult {
  /** Objects in the pack (including already-existing re-pushed ones). */
  readonly objectCount: number;
  /** SQL staging time, when measured by the streaming ingest path. */
  readonly stageMs?: number | undefined;
  /** Per-phase CPU split of ingest (ms) — see `PackParser` `phases`. */
  readonly phases?: Record<string, number> | undefined;
  /** Objects staged as references into a promoted wire pack (DESIGN §22.5). */
  readonly promoted?: number | undefined;
  /** The completed spilled object's key, when the body spilled (DESIGN §22.10). */
  readonly parkedKey?: string | undefined;
  /** The resolved pack's key — delta-resolved blobs, promoted (DESIGN §22.13). */
  readonly resolvedKey?: string | undefined;
  /** The pack's trailer checksum (hex). */
  readonly packSha: string;
  /** Staged commits (commit-graph rows are inserted at finalize). */
  readonly commits: ReadonlyArray<StagedCommitInfo>;
  /** Oids referenced by staged trees/tags + commit trees (hard edges). */
  readonly referenced: ReadonlyArray<Oid>;
  /** Oids referenced as commit parents (soft under shallow import). */
  readonly referencedParents: ReadonlyArray<Oid>;
}

/** Bounded LRU of inflated contents shared across delta resolution. */
const makeContentCache = (budget: number) => {
  const map = new Map<string, Uint8Array>();
  let total = 0;
  return {
    get: (key: string): Uint8Array | undefined => {
      const value = map.get(key);
      if (value !== undefined) {
        map.delete(key);
        map.set(key, value);
      }
      return value;
    },
    set: (key: string, value: Uint8Array): void => {
      if (value.byteLength > budget || map.has(key)) return;
      map.set(key, value);
      total += value.byteLength;
      for (const [k, v] of map) {
        if (total <= budget) break;
        map.delete(k);
        total -= v.byteLength;
      }
    },
  };
};

/** Delta-resolution content cache budget (DESIGN.md §3.6): 20 MiB. */
const CACHE_BUDGET = 20 * 1024 * 1024;
/** Maximum delta-chain depth tolerated (git's own default is 50). */
const MAX_DELTA_DEPTH = 64;

interface RawEntry {
  readonly offset: number;
  readonly kind: "object" | "ofs" | "ref";
  /** Real object type for `kind: "object"`. */
  readonly type: ObjectType | undefined;
  /** Header size (object size, or delta payload size for deltas). */
  readonly declaredSize: number;
  /** Where this entry's zlib stream starts. */
  readonly zstart: number;
  /** Exact compressed span length. */
  readonly zlen: number;
  readonly baseOffset: number | undefined;
  readonly baseOid: Oid | undefined;
  /** Filled once resolved. */
  oid: Oid | undefined;
  resolvedType: ObjectType | undefined;
}

/**
 * The store surface ingest needs (DESIGN §22.10): staging rows and thin
 * delta bases. The Repo DO satisfies it directly; the Worker satisfies it
 * over RPC so the pack never enters the Durable Object.
 */
export interface IngestStore {
  readonly insertStagedBatch: ObjectStore["insertStagedBatch"];
  /** Awaits staging that `insertStagedBatch` may have left in flight. */
  readonly settle?: Effect.Effect<void, StoreError> | undefined;
  /** A live base object for a thin delta, or `undefined` when absent. */
  readonly readBase: (
    oid: Oid,
  ) => Effect.Effect<
    { readonly type: ObjectType; readonly content: Uint8Array } | undefined,
    StoreError
  >;
}

/** An {@link IngestStore} over a full {@link ObjectStore}. */
export const ingestStoreOf = (store: ObjectStore): IngestStore => ({
  insertStagedBatch: store.insertStagedBatch,
  readBase: (oid) =>
    store
      .getMeta(oid)
      .pipe(
        Effect.flatMap((meta) =>
          meta === undefined
            ? Effect.succeed(undefined)
            : store
                .readContent(oid)
                .pipe(Effect.map((content) => ({ type: meta.type, content }))),
        ),
      ),
});

/** Options of {@link ingestPack}. */
export interface IngestOptions {
  readonly store: IngestStore;
  readonly pushId: string;
  /**
   * When the wire body was spilled to blob storage, stage non-delta blobs
   * as references into it (DESIGN §22.5): `packId` is the wire pack's id,
   * `base` the pack's byte offset within the spilled object (the request's
   * pkt-line commands precede it).
   */
  readonly promote?:
    | (() => { readonly packId: string; readonly base: number } | undefined)
    | undefined;
  /**
   * When set, entries are inflated and hashed by the hasher service one
   * spilled part at a time (DESIGN §22.7) instead of by the in-process
   * parser; the DO only pumps bytes and stages rows.
   */
  readonly hasher?: HasherShape | undefined;
  /** Bytes per hasher part (tests shrink it). @default HASH_PART_BYTES */
  readonly partBytes?: number | undefined;
  /**
   * The streaming spill (DESIGN §22.10): the pump reads the whole request
   * BODY in uniform parts, each hasher writes its part to blob storage,
   * and the completed object is the promotion target (`packId`) and the
   * source's fallback reader. Bodies that end within `threshold` bytes
   * stay in memory and nothing is written.
   */
  readonly spill?:
    | {
        readonly body: RandomAccess;
        readonly feeder: StreamingFeeder;
        readonly packStart: number;
        readonly blobs: BlobStoreShape;
        readonly key: string;
        readonly packId: string;
        readonly repoId: string;
        readonly threshold: number;
      }
    | undefined;
  /**
   * Shallow-import mode: commit parents may be absent (they become walk
   * boundaries); trees/blobs/tags must still be fully connected.
   */
  readonly allowMissingParents?: boolean | undefined;
}

/**
 * Single-pass buffered pack ingest (DESIGN.md §3.6): parse entries,
 * store non-delta compressed spans **verbatim**, resolve ofs/ref deltas
 * (thin bases from the live store), enforce the 64 MiB object cap, verify
 * the trailer SHA-1, and stage everything under `pushId`.
 *
 * The v1.x streaming upgrade seam: this function's only view of the pack
 * is `pack: Uint8Array` random access — swapping in an R2-backed
 * `RandomAccess` touches this implementation, not the protocol drivers.
 */
/**
 * Ingests a pack from a {@link RandomAccess} source — the path that has **no
 * size cap** (DESIGN.md §3.6). Memory is bounded by the source's read
 * window and the delta LRU rather than by the pack, so the source can be an
 * R2 object of any size (see `Store/PackSource.ts`).
 *
 * Delegates the wire-format work to the pure `PackParser` (which the pack
 * fixtures in `test/pack.test.ts` cover directly) and does the repo-side
 * work in its sink: stage the object, and record commit-graph edges.
 * Blobs are staged without inflating — only commits, trees and tags need
 * their content parsed, and those are small.
 */
export const ingestPackFrom = (
  source: RandomAccess,
  options: IngestOptions,
): Effect.Effect<IngestResult, PackIngestError | StoreError> =>
  Effect.gen(function* () {
    const { store, pushId } = options;
    const commits: Array<StagedCommitInfo> = [];
    const referenced = new Set<Oid>();
    const referencedParents = new Set<Oid>();

    const record = Effect.fn(function* (
      oid: Oid,
      type: ObjectType,
      content: Uint8Array,
    ) {
      switch (type) {
        case ObjectType.commit: {
          const parsed = yield* parseCommit(content).pipe(
            Effect.mapError(
              (error) =>
                new PackIngestError({
                  reason: `bad commit ${oid}: ${error.reason}`,
                }),
            ),
          );
          commits.push({
            oid,
            tree: parsed.tree,
            parents: parsed.parents,
            commitTime: parsed.committer.when,
          });
          referenced.add(parsed.tree);
          for (const parent of parsed.parents) referencedParents.add(parent);
          return;
        }
        case ObjectType.tree: {
          const parsed = yield* parseTree(content).pipe(
            Effect.mapError(
              (error) =>
                new PackIngestError({
                  reason: `bad tree ${oid}: ${error.reason}`,
                }),
            ),
          );
          for (const entry of parsed) {
            if (treeEntryKind(entry.mode) !== "commit") {
              referenced.add(entry.oid);
            }
          }
          return;
        }
        case ObjectType.tag: {
          const parsed = yield* parseTag(content).pipe(
            Effect.mapError(
              (error) =>
                new PackIngestError({
                  reason: `bad tag ${oid}: ${error.reason}`,
                }),
            ),
          );
          referenced.add(parsed.object);
          return;
        }
        case ObjectType.blob:
          return;
      }
    });

    // Stage in batches: one transaction per batch instead of one (plus an
    // existence probe) per object. That per-object cost is what made a
    // 13.7k-object push take ~20 s inside a single-threaded DO — the work
    // is inherently serial, so the only lever is fewer operations
    // (DESIGN.md §16.6).
    // Buffered entries keep their pack coordinates so the promote/inline
    // decision is made at FLUSH time (DESIGN §22.6): a streaming body only
    // becomes a wire pack once it crosses the spill threshold, but the wire
    // object holds the body from byte 0, so entries buffered before that
    // moment can still be promoted when the flush happens after it.
    /** What the parser or the hasher hands over per entry. */
    interface Incoming {
      readonly oid: Oid;
      readonly type: ObjectType;
      readonly size: number;
      /** Absent for hasher-scanned non-delta entries: read from the source if the row stays inline. */
      readonly zdata?: Uint8Array | undefined;
      readonly span?: number | undefined;
      readonly dataOffset: number;
      readonly fromDelta: boolean;
      readonly content?: Uint8Array | undefined;
      /** Already in a pack in blob storage (the resolved pack, DESIGN §22.13). */
      readonly pack?:
        | { readonly packId: string; readonly offset: number }
        | undefined;
    }
    let batch: Array<Incoming> = [];
    let batchBytes = 0;
    let promoted = 0;
    /** Time spent in SQL staging; the rest of ingest is CPU. */
    let stageMs = 0;
    const flush = Effect.fn(function* () {
      if (batch.length === 0) return;
      const pending = batch;
      batch = [];
      batchBytes = 0;
      const target =
        options.promote?.() ??
        (spilling && options.spill !== undefined
          ? { packId: options.spill.packId, base: options.spill.packStart }
          : undefined);
      const staged: Array<StagedObject> = [];
      for (const entry of pending) {
        const pack =
          entry.pack ??
          (target !== undefined &&
          !entry.fromDelta &&
          entry.type === ObjectType.blob &&
          entry.dataOffset >= 0
            ? { packId: target.packId, offset: target.base + entry.dataOffset }
            : undefined);
        if (pack !== undefined) promoted += 1;
        // A promoted row needs no bytes; an inline row needs its zdata —
        // the hasher path did not ship it, so read the span back.
        const zdata =
          entry.zdata ??
          (pack === undefined
            ? Uint8Array.from(
                readSpan?.(entry.dataOffset, entry.span ?? 0) ??
                  (yield* source.read(entry.dataOffset, entry.span ?? 0)),
              )
            : new Uint8Array(0));
        staged.push({
          oid: entry.oid,
          type: entry.type,
          size: entry.size,
          zdata,
          zsize: entry.zdata?.byteLength ?? entry.span,
          pack,
        });
      }
      const at = yield* Effect.sync(() => performance.now());
      yield* store.insertStagedBatch(pushId, staged);
      stageMs += yield* Effect.sync(() => performance.now() - at);
    });

    const phases: Record<string, number> = {};
    /** The spill's multipart upload, once the pump decided to spill. */
    let upload: BlobMultipart | undefined;
    let spilling = false;
    /** Set once the spilled object is complete: it is the wire pack. */
    let parkedKey: string | undefined;
    /** Set once the resolved pack(s) are written (DESIGN §22.13). */
    let resolvedKey: string | undefined;
    const resolvedKeys: Array<string> = [];
    /**
     * Delta-resolved blobs held back from staging while the body spills:
     * their fresh zlib goes into one resolved pack in blob storage and the
     * rows become coordinates, so the DO never writes those bytes.
     */
    const resolvedBlobs: Array<Incoming> = [];
    /** In-memory span reads over the retained parts (set by the pump). */
    let readSpan:
      | ((at: number, length: number) => Uint8Array | undefined)
      | undefined;
    /**
     * Stages a run of resolved entries (DESIGN §22.5): the parser's
     * synchronous fast path hands over up to SINK_BATCH non-delta entries
     * per fiber hop; delta-resolved entries arrive one at a time.
     */
    /** Every oid this push stages: connectivity only asks the store about the rest. */
    const stagedOids = new Set<Oid>();
    const stage = (entries: ReadonlyArray<Incoming>) =>
      Effect.gen(function* () {
        for (const entry of entries) {
          stagedOids.add(entry.oid);
          if (
            spilling &&
            entry.fromDelta &&
            entry.type === ObjectType.blob &&
            entry.pack === undefined &&
            entry.zdata !== undefined
          ) {
            resolvedBlobs.push(entry);
            continue;
          }
          batch.push(entry);
          // Counted as inline until the flush decides; promoted rows carry
          // no BLOB, so this over-counts — safe for a memory cap.
          batchBytes += entry.zdata?.byteLength ?? entry.span ?? 0;
          if (
            batch.length >= STAGE_BATCH_OBJECTS ||
            batchBytes >= STAGE_BATCH_BYTES
          ) {
            yield* flush();
          }
          if (entry.type !== ObjectType.blob) {
            if (entry.content === undefined) {
              return yield* new PackIngestError({
                reason: `no content for ${entry.oid} (type ${entry.type})`,
              });
            }
            yield* record(entry.oid, entry.type, entry.content);
          }
        }
      });
    /**
     * The hasher pipeline (DESIGN §22.7): pump the pack in parts through
     * the hasher; every part carries the previous part's incomplete tail.
     * The DO's own CPU here is a memcpy, the trailer SHA-1 and staging.
     */
    const pumpThroughHasher = (hasher: HasherShape) =>
      Effect.gen(function* () {
        const spill = options.spill;
        // Spill parts (uniform, ≥ 5 MiB for R2) and hash chunks: a hasher
        // may want smaller chunks than a part (a Lambda's 6 MB payload);
        // chunks then divide parts and the pump uploads the parts itself.
        const partBytes =
          options.partBytes ??
          (spill === undefined ? HASH_PART_BYTES : SPILL_PART_BYTES);
        const wanted = hasher.chunkBytes ?? partBytes;
        const hashBytes =
          wanted < partBytes && partBytes % wanted === 0 ? wanted : partBytes;
        const asIngest = (error: {
          readonly _tag: string;
          readonly reason?: string;
        }) =>
          new PackIngestError({
            reason: `${error._tag}${error.reason === undefined ? "" : `: ${error.reason}`}`,
          });
        const header = yield* source.read(0, 12);
        if (
          header.length < 12 ||
          header[0] !== 0x50 ||
          header[1] !== 0x41 ||
          header[2] !== 0x43 ||
          header[3] !== 0x4b
        ) {
          return yield* new PackIngestError({ reason: "bad pack magic" });
        }
        const count = new DataView(header.buffer, header.byteOffset).getUint32(
          8,
        );
        // Trailer SHA-1 over [0, total − 20): hash with a 20-byte lag, so
        // the last 20 bytes seen are the trailer itself.
        const trailerSha = makeSha1();
        let lag = new Uint8Array(0);
        const feed = (bytes: Uint8Array) => {
          const joined = lag.length === 0 ? bytes : concatBytes([lag, bytes]);
          if (joined.length > 20) {
            trailerSha.update(joined.subarray(0, joined.length - 20));
            lag = Uint8Array.from(joined.subarray(joined.length - 20));
          } else {
            lag = Uint8Array.from(joined);
          }
        };
        interface Known {
          readonly oid: Oid;
          readonly type: ObjectType;
          readonly dataOffset: number;
          readonly span: number;
          readonly zdata?: Uint8Array | undefined;
          readonly content?: Uint8Array | undefined;
        }
        const known = new Map<number, Known>(); // by header offset
        const knownByOid = new Map<string, Known>();
        const unresolved: Array<UnresolvedDelta> = [];
        // Raw-chunk dispatch (DESIGN §22.9–10): NO scanning here. Every
        // chunk goes to a hasher as it arrives (bounded concurrency), which
        // resyncs to the first entry boundary inside the chunk and scans and
        // hashes from there — and, when the body spills, writes the chunk
        // as its part of the multipart upload. Results are consumed in
        // chunk order, concurrently with the receive; the one entry
        // straddling each chunk edge is stitched from the neighbouring
        // payloads and hashed by a small extra call. A boundary that does
        // not line up (a resync false positive) falls back to a sequential
        // rescan of that chunk from the known boundary.
        const gate = yield* Semaphore.make(
          hasher.concurrency ?? HASH_CONCURRENCY,
        );
        interface Chunk {
          readonly index: number;
          /** Pack-relative offset of payload[0] (negative for a body-aligned first part). */
          readonly base: number;
          readonly payload: Uint8Array;
          readonly fiber: Fiber.Fiber<HashPartResult, PackIngestError>;
        }
        const chunks: Array<Chunk> = [];
        const bytesFrom = (from: number, to: number): Uint8Array => {
          const pieces: Array<Uint8Array> = [];
          for (const c of chunks) {
            const start = Math.max(from, c.base);
            const end = Math.min(to, c.base + c.payload.length);
            if (end > start)
              pieces.push(c.payload.subarray(start - c.base, end - c.base));
          }
          if (pieces.length === 1) return pieces[0]!;
          // Neighbouring chunks are views of one slab: hand out one view.
          const first = pieces[0]!;
          let contiguous = true;
          let end = first.byteOffset + first.byteLength;
          for (let i = 1; i < pieces.length; i++) {
            const piece = pieces[i]!;
            if (piece.buffer !== first.buffer || piece.byteOffset !== end) {
              contiguous = false;
              break;
            }
            end += piece.byteLength;
          }
          return contiguous
            ? new Uint8Array(
                first.buffer,
                first.byteOffset,
                end - first.byteOffset,
              )
            : concatBytes(pieces);
        };
        // Retained payloads serve every span read (inline rows, delta
        // bases and deltas) so nothing goes back to the source or the
        // spilled object during ingest.
        readSpan = (at, length) => {
          const bytes = bytesFrom(at, at + length);
          return bytes.length === length ? bytes : undefined;
        };
        const stageResult = (
          payload: Uint8Array,
          base: number,
          result: ScanResult,
        ) =>
          Effect.gen(function* () {
            const incoming: Array<Incoming> = [];
            for (const e of result.entries) {
              // A hasher may omit non-blob content to bound its response
              // (a Lambda): inflate it here from the fresh zdata or the
              // retained span — trees, commits and tags are small.
              const content =
                e.content ??
                (e.type === ObjectType.blob
                  ? undefined
                  : yield* Zlib.inflate(
                      e.zdata ??
                        payload.subarray(
                          e.dataOffset - base,
                          e.dataOffset - base + e.span,
                        ),
                    ).pipe(Effect.mapError(asIngest)));
              const item: Known = {
                oid: e.oid,
                type: e.type,
                dataOffset: e.dataOffset,
                span: e.span,
                zdata: e.zdata,
                content,
              };
              known.set(e.offset, item);
              knownByOid.set(e.oid, item);
              incoming.push({
                oid: e.oid,
                type: e.type,
                size: e.size,
                zdata:
                  e.zdata ??
                  payload.subarray(
                    e.dataOffset - base,
                    e.dataOffset - base + e.span,
                  ),
                span: e.span,
                dataOffset: e.dataOffset,
                fromDelta: e.zdata !== undefined,
                content,
              });
            }
            yield* stage(incoming);
            // Batches flush by size (STAGE_BATCH_OBJECTS / _BYTES), not per
            // chunk: the retained parts hold every span until ingest ends.
            for (const u of result.unresolved) unresolved.push(u);
            return result.count;
          });

        // ── phase 1 (producer): read parts as they arrive, dispatch each ──
        // Wall-clock phase split (Date.now advances across awaits; the
        // platform's cpuTime is the CPU attribution): `PushStats.phases`.
        const pumpStarted = Date.now();
        let regionCalls = 0;
        // Each part's identity arrives after its upload; joined before
        // the multipart upload is completed, never on the scan path.
        const parts: Array<Effect.Effect<UploadedPart, PackIngestError>> = [];
        let producerDone = false;
        const wakers: Array<() => void> = [];
        const notifyConsumer = () => {
          for (const w of wakers.splice(0)) w();
        };
        const awaitChunk = (k: number) =>
          Effect.suspend(() =>
            k < chunks.length || producerDone
              ? Effect.void
              : Effect.callback<void>((resume) => {
                  wakers.push(() => resume(Effect.void));
                }),
          );
        const availableEnd = () => {
          const last = chunks[chunks.length - 1];
          return last === undefined ? 12 : last.base + last.payload.length;
        };
        const dispatch = (
          payload: Uint8Array,
          opts: {
            readonly base: number;
            readonly skip: number;
            readonly resync: boolean;
            readonly partNumber: number;
          },
        ) =>
          Effect.forkChild(
            Semaphore.withPermits(
              gate,
              1,
            )(
              hasher
                .hashPart(payload, {
                  base: opts.base,
                  skip: opts.skip,
                  remaining: count,
                  maxObjectSize: MAX_OBJECT_SIZE,
                  resync: opts.resync,
                  spill:
                    upload === undefined ||
                    spill === undefined ||
                    !hasher.writesSpill
                      ? undefined
                      : {
                          key: spill.key,
                          uploadId: upload.uploadId,
                          partNumber: opts.partNumber,
                        },
                })
                .pipe(Effect.mapError(asIngest)),
            ),
          );
        const produce = Effect.gen(function* () {
          if (spill === undefined) {
            // Pack-relative parts from the (in-memory or spilled) source.
            feed(header);
            let offset = 12;
            let index = 0;
            while (true) {
              const chunk = yield* source.read(offset, partBytes);
              if (chunk.length === 0) break;
              feed(chunk);
              const fiber = yield* dispatch(chunk, {
                base: offset,
                skip: 0,
                resync: index > 0,
                partNumber: index + 1,
              });
              chunks.push({ index, base: offset, payload: chunk, fiber });
              offset += chunk.length;
              index += 1;
              notifyConsumer();
              source.release?.(offset);
              if (chunk.length < partBytes) break;
            }
            return;
          }
          // Body-aligned parts (DESIGN §22.10): part k is body
          // [k·P, (k+1)·P); the first carries the command section and
          // the pack header before its first entry (`skip`). Chunks of
          // `hashBytes` divide the parts.
          const { body, packStart } = spill;
          const uploadGate = yield* Semaphore.make(3);
          let partStart = 0;
          /** Upload body [partStart, end) as the next part (pump-owned spill). */
          const uploadPart = (end: number) =>
            Effect.gen(function* () {
              if (upload === undefined || end <= partStart) return;
              const settled = upload;
              const partNumber = Math.floor(partStart / partBytes) + 1;
              const bytes = bytesFrom(partStart - packStart, end - packStart);
              partStart = end;
              const fiber = yield* Effect.forkDetach(
                Semaphore.withPermits(
                  uploadGate,
                  1,
                )(
                  spill.blobs
                    .uploadPart(spill.key, settled.uploadId, partNumber, bytes)
                    .pipe(
                      Effect.mapError(
                        (error) =>
                          new PackIngestError({
                            reason: `spill part ${partNumber}: ${error.reason}`,
                          }),
                      ),
                      Effect.provide(RuntimeContext.phantom),
                    ),
                ),
              );
              parts.push(Fiber.join(fiber));
            });
          let index = 0;
          let received = 0;
          while (true) {
            const at = index * hashBytes;
            const chunk = yield* body.read(at, hashBytes);
            if (chunk.length === 0) break;
            if (index === 0) {
              // Decide the spill once the first chunk is in: a body that
              // ended within the in-memory threshold stays in memory.
              const ended = spill.feeder.source.ended();
              if (!(ended && spill.feeder.source.size <= spill.threshold)) {
                upload = yield* spill.blobs.multipart(spill.key).pipe(
                  Effect.mapError(
                    (error) =>
                      new PackIngestError({
                        reason: `spill: ${error.reason}`,
                      }),
                  ),
                  Effect.provide(RuntimeContext.phantom),
                );
                spill.feeder.expectFallback();
                spilling = true;
              }
            }
            const skip = index === 0 ? packStart + 12 : 0;
            feed(index === 0 ? chunk.subarray(packStart) : chunk);
            const base = at - packStart;
            const fiber = yield* dispatch(chunk, {
              base: base + skip,
              skip,
              resync: index > 0,
              partNumber: Math.floor(at / partBytes) + 1,
            });
            console.log(
              `[pump] chunk ${index + 1} read at +${Date.now() - pumpStarted}ms (${chunk.length} bytes)`,
            );
            chunks.push({ index, base, payload: chunk, fiber });
            index += 1;
            received = at + chunk.length;
            notifyConsumer();
            body.release?.(received);
            if (!hasher.writesSpill && received % partBytes === 0) {
              yield* uploadPart(received);
            }
            if (chunk.length < hashBytes) break;
          }
          if (!hasher.writesSpill) yield* uploadPart(received);
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              producerDone = true;
              notifyConsumer();
            }),
          ),
        );

        // ── phase 2 (consumer): settle results in chunk order ──────────
        // `prevEnd` is the last settled boundary. A chunk's resync result
        // covers [firstOffset, …); whatever lies in [prevEnd, firstOffset)
        // — usually one straddling entry, but any number when chunks are
        // tiny — is scanned sequentially as one region from the retained
        // payloads. Entries the region scan reaches at or past
        // `firstOffset` are duplicates of the chunk's own result and are
        // dropped; a region that does not end exactly at `firstOffset`
        // means the resync was a false positive, and the chunk is rescanned
        // sequentially from `prevEnd` instead.
        const keepBelow = (result: ScanResult, limit: number): ScanResult => {
          const entries = result.entries.filter((e) => e.offset < limit);
          const unresolved = result.unresolved.filter((u) => u.offset < limit);
          // The settled boundary is the END of the last kept entry — which
          // may lie past `limit` when that entry straddles a chunk edge.
          let end = result.count === 0 ? result.consumedTo : -1;
          for (const e of entries) end = Math.max(end, e.dataOffset + e.span);
          for (const u of unresolved)
            end = Math.max(end, u.dataOffset + u.span);
          return {
            firstOffset: result.firstOffset,
            entries,
            unresolved,
            consumedTo: end < 0 ? result.consumedTo : end,
            count: entries.length + unresolved.length,
          };
        };
        const trace =
          process.env.GIT_PUMP_DEBUG === "1"
            ? (...args: Array<unknown>) => console.log("[pump]", ...args)
            : () => {};
        // The consumer is the forked side: hash fibers are children of THIS
        // fiber (a child's children die with it), so the producer runs here
        // and the consumer settles results as they land.
        // The entry straddling a part edge is hashed as soon as its part
        // settles — sized from its own header, from the retained bytes —
        // so a large object crossing several parts (a 10 MB blob spans
        // three) is verified alongside the parts, not after the last one.
        interface Speculative {
          readonly start: number;
          readonly fiber: Fiber.Fiber<
            { readonly bytes: Uint8Array; readonly r: ScanResult },
            PackIngestError
          >;
        }
        const speculate = (start: number) =>
          Effect.gen(function* () {
            const head = bytesFrom(start, Math.min(start + 32, availableEnd()));
            let need = start + 64;
            try {
              const h = decodeTypeSize(head, 0);
              // zlib's worst case is ~0.1% + a few bytes; deltas carry an
              // offset varint before their stream.
              need = start + h.next + Math.ceil(h.size * 1.001) + 80;
            } catch {
              // Header cut by the received edge: wait for more below.
            }
            while (true) {
              const end = Math.min(need, availableEnd());
              const bytes = bytesFrom(start, end);
              const r = yield* hasher
                .hashPart(bytes, {
                  base: start,
                  remaining: 1,
                  maxObjectSize: MAX_OBJECT_SIZE,
                })
                .pipe(Effect.mapError(asIngest));
              if (r.count === 1) return { bytes, r };
              if (producerDone && end >= availableEnd()) return { bytes, r };
              // Not complete in what has arrived: wait for another part.
              if (end >= availableEnd()) yield* awaitChunk(chunks.length);
              if (end >= need) need = availableEnd();
            }
          });
        const consume = Effect.gen(function* () {
          let staged = 0;
          let prevEnd = 12;
          let speculative: Speculative | undefined;
          for (let k = 0; ; k++) {
            yield* awaitChunk(k);
            if (k >= chunks.length) break;
            const current = chunks[k]!;
            const result = yield* Fiber.join(current.fiber);
            console.log(
              `[pump] chunk ${k + 1} settled at +${Date.now() - pumpStarted}ms`,
            );
            if (result.part !== undefined) {
              parts.push(result.part.pipe(Effect.mapError(asIngest)));
            }
            const chunkEnd = current.base + current.payload.length;
            trace(
              `chunk ${k} base=${current.base} len=${current.payload.length} first=${result.firstOffset} consumedTo=${result.consumedTo} count=${result.count} prevEnd=${prevEnd} staged=${staged}`,
            );
            const sequential = () =>
              Effect.gen(function* () {
                // Everything from the settled boundary through this chunk,
                // scanned in order (plus a little of the next chunk so the last
                // entry can complete, if there is one).
                yield* awaitChunk(k + 1);
                const next = chunks[k + 1];
                const to =
                  next === undefined
                    ? chunkEnd
                    : Math.min(chunkEnd + 64, next.base + next.payload.length);
                const bytes = bytesFrom(prevEnd, to);
                const r = yield* hasher
                  .hashPart(bytes, {
                    base: prevEnd,
                    remaining: count - staged,
                    maxObjectSize: MAX_OBJECT_SIZE,
                  })
                  .pipe(Effect.mapError(asIngest));
                return { bytes, base: prevEnd, r: keepBelow(r, chunkEnd) };
              });
            if (result.firstOffset < 0) {
              // No boundary in this chunk (tiny, or inside one huge entry):
              // its bytes are settled by the pending straddler or a later
              // chunk's region scan.
              continue;
            }
            if (speculative !== undefined) {
              const sp = yield* Fiber.join(speculative.fiber);
              const start = speculative.start;
              speculative = undefined;
              if (
                sp.r.count === 1 &&
                start === prevEnd &&
                sp.r.consumedTo <= result.firstOffset
              ) {
                staged += yield* stageResult(sp.bytes, start, sp.r);
                prevEnd = sp.r.consumedTo;
              }
              // Otherwise the boundary is suspect: the paths below rescan.
            }
            if (k === 0 && result.firstOffset !== 12) {
              const again = yield* sequential();
              staged += yield* stageResult(again.bytes, again.base, again.r);
              prevEnd = again.r.consumedTo;
              continue;
            }
            if (result.firstOffset < prevEnd) {
              // Resync landed inside an already-settled entry: rescan.
              const again = yield* sequential();
              staged += yield* stageResult(again.bytes, again.base, again.r);
              prevEnd = again.r.consumedTo;
              continue;
            }
            if (result.firstOffset > prevEnd) {
              trace(`  region [${prevEnd}, ${result.firstOffset})`);
              regionCalls += 1;
              const region = bytesFrom(
                prevEnd,
                Math.min(result.firstOffset + 64, chunkEnd),
              );
              const scanned = yield* hasher
                .hashPart(region, {
                  base: prevEnd,
                  remaining: count - staged,
                  maxObjectSize: MAX_OBJECT_SIZE,
                })
                .pipe(Effect.mapError(asIngest));
              const ends =
                scanned.entries.some(
                  (e) => e.dataOffset + e.span === result.firstOffset,
                ) ||
                scanned.unresolved.some(
                  (u) => u.dataOffset + u.span === result.firstOffset,
                );
              trace(
                `  region scan count=${scanned.count} consumedTo=${scanned.consumedTo} ends=${ends}`,
              );
              if (!ends) {
                trace(`  → sequential fallback`);
                const again = yield* sequential();
                staged += yield* stageResult(again.bytes, again.base, again.r);
                prevEnd = again.r.consumedTo;
                continue;
              }
              staged += yield* stageResult(
                region,
                prevEnd,
                keepBelow(scanned, result.firstOffset),
              );
            }
            staged += yield* stageResult(current.payload, current.base, result);
            prevEnd = result.consumedTo;
            if (prevEnd < chunkEnd && staged < count) {
              const start = prevEnd;
              speculative = {
                start,
                fiber: yield* Effect.forkChild(speculate(start)),
              };
            }
          }
          // A straddler still pending at the end (the last parts held no
          // boundary): settle it before the tail scan.
          if (speculative !== undefined) {
            const sp = yield* Fiber.join(speculative.fiber);
            const start = speculative.start;
            speculative = undefined;
            if (sp.r.count === 1 && start === prevEnd) {
              staged += yield* stageResult(sp.bytes, start, sp.r);
              prevEnd = sp.r.consumedTo;
            }
          }
          return { staged, prevEnd };
        });
        const consumer = yield* Effect.forkChild(consume);
        yield* produce;
        console.log(`[pump] body ended at +${Date.now() - pumpStarted}ms`);
        phases.upload = Date.now() - pumpStarted;
        let { staged, prevEnd } = yield* Fiber.join(consumer);
        // The tail: chunks too small to hold two whole entries report no
        // boundary, so entries after the last settled boundary may remain.
        // Scan that final region sequentially (it ends at the trailer).
        if (staged < count) {
          const last = chunks[chunks.length - 1];
          if (last !== undefined) {
            const to = last.base + last.payload.length;
            if (to > prevEnd) {
              const bytes = bytesFrom(prevEnd, to);
              const r = yield* hasher
                .hashPart(bytes, {
                  base: prevEnd,
                  remaining: count - staged,
                  maxObjectSize: MAX_OBJECT_SIZE,
                })
                .pipe(Effect.mapError(asIngest));
              staged += yield* stageResult(bytes, prevEnd, r);
              prevEnd = r.consumedTo;
            }
          }
        }
        const consumedTo = prevEnd;
        phases.scan = Date.now() - pumpStarted;
        phases.chunks = chunks.length;
        phases.regions = regionCalls;
        if (staged !== count) {
          return yield* new PackIngestError({
            reason: `pack declared ${count} entries, scanned ${staged}`,
          });
        }
        const total =
          source.awaitEnd === undefined
            ? source.size
            : yield* source.awaitEnd.pipe(Effect.mapError(asIngest));
        if (consumedTo !== total - 20) {
          return yield* new PackIngestError({
            reason: `pack has ${total - 20 - consumedTo} unconsumed bytes after ${count} entries`,
          });
        }
        // Everything read so far went through `feed`; the last part's
        // bytes did too, so the lag now holds the trailer.
        if (lag.length !== 20) {
          return yield* new PackIngestError({
            reason: "truncated pack trailer",
          });
        }
        const expected = bytesToHex(lag);
        const actual = trailerSha.digestHex();
        if (expected !== actual) {
          return yield* new PackIngestError({
            reason: `pack checksum mismatch: expected ${expected}, got ${actual}`,
          });
        }
        // Cross-part and thin deltas: bases are in the retained payloads
        // (or in the live store). Fixpoint for chains.
        const deltasStarted = Date.now();
        phases.unresolved = unresolved.length;
        // The resolved pack (DESIGN §22.13): every delta-resolved blob's
        // fresh zlib, `typeSize header + zdata` per entry, one object; rows
        // point at their zdata like promoted wire-pack rows do. Written in
        // two parts so the in-chunk resolutions — most of them — upload
        // while the cross-chunk rounds run.
        const writeResolvedPack = (suffix: string) =>
          Effect.gen(function* () {
            if (resolvedBlobs.length === 0 || spill === undefined) return;
            const packId = `${spill.packId}${suffix}`;
            const key = packKeyOf(spill.repoId, packId);
            const pieces: Array<Uint8Array> = [];
            const rows: Array<Incoming> = [];
            let cursor = 0;
            for (const entry of resolvedBlobs) {
              const header = encodeTypeSize(entry.type, entry.size);
              pieces.push(header, entry.zdata!);
              rows.push({
                ...entry,
                pack: { packId, offset: cursor + header.length },
              });
              cursor += header.length + entry.zdata!.byteLength;
            }
            resolvedBlobs.length = 0;
            const bytes = concatBytes(pieces);
            const writeStarted = Date.now();
            const writing = yield* Effect.forkDetach(
              spill.blobs.put(key, bytes).pipe(
                Effect.mapError(
                  (error) =>
                    new PackIngestError({
                      reason: `resolved pack: ${error.reason}`,
                    }),
                ),
                Effect.provide(RuntimeContext.phantom),
              ),
            );
            resolvedKeys.push(key);
            resolvedKey = resolvedKeys.join(",");
            phases.resolvedBytes = (phases.resolvedBytes ?? 0) + bytes.length;
            yield* stage(rows);
            return { writing, writeStarted };
          });
        const early = yield* writeResolvedPack("-r");
        const spanOf = (at: number, length: number) =>
          Effect.suspend(() => {
            const bytes = readSpan?.(at, length);
            return bytes === undefined
              ? source.read(at, length)
              : Effect.succeed(bytes);
          });
        const inflateSpan = (item: Known) =>
          item.content !== undefined
            ? Effect.succeed(item.content)
            : item.zdata !== undefined
              ? Zlib.inflate(item.zdata).pipe(Effect.mapError(asIngest))
              : spanOf(item.dataOffset, item.span).pipe(
                  Effect.flatMap((z) => Zlib.inflate(z)),
                  Effect.mapError(asIngest),
                );
        // Rounds (DESIGN §22.13): every delta whose base is known goes into
        // byte-bounded batches the hasher resolves in parallel (its bases
        // shipped once per batch); a delta on a still-unresolved delta waits
        // for the next round. The receiver only assembles bytes it already
        // holds.
        const batchBudget = hasher.chunkBytes ?? HASH_PART_BYTES;
        const baseBytesOf = (item: Known) =>
          Effect.gen(function* () {
            if (item.content !== undefined) {
              return { bytes: item.content, isContent: true };
            }
            if (item.zdata !== undefined) {
              return { bytes: item.zdata, isContent: false };
            }
            return {
              bytes: yield* spanOf(item.dataOffset, item.span),
              isContent: false,
            };
          });
        let pending = unresolved;
        while (pending.length > 0) {
          const next: Array<UnresolvedDelta> = [];
          interface Ready {
            readonly u: UnresolvedDelta;
            readonly base: Known;
            readonly baseKey: string;
          }
          const ready: Array<Ready> = [];
          for (const u of pending) {
            let base: Known | undefined =
              u.baseOffset !== undefined ? known.get(u.baseOffset) : undefined;
            if (base === undefined && u.baseOid !== undefined) {
              base = knownByOid.get(u.baseOid);
              if (base === undefined) {
                const live = yield* store.readBase(u.baseOid);
                if (live !== undefined) {
                  base = {
                    oid: u.baseOid,
                    type: live.type,
                    dataOffset: -1,
                    span: 0,
                    content: live.content,
                  };
                  knownByOid.set(u.baseOid, base);
                }
              }
            }
            if (base === undefined) {
              next.push(u);
              continue;
            }
            ready.push({
              u,
              base,
              baseKey:
                base.dataOffset >= 0
                  ? `o:${base.dataOffset}`
                  : `oid:${base.oid}`,
            });
          }
          if (ready.length === 0) {
            return yield* new PackIngestError({
              reason: `delta base not found for ${next.length} entries`,
            });
          }
          // Greedy byte-bounded batches; a base shared by several deltas is
          // carried once per batch.
          interface Batch {
            readonly bases: Array<DeltaBase>;
            readonly index: Map<string, number>;
            readonly jobs: Array<DeltaJob>;
            readonly items: Array<Ready>;
            bytes: number;
          }
          const batches: Array<Batch> = [];
          let current: Batch | undefined;
          for (const r of ready) {
            const delta = yield* spanOf(r.u.dataOffset, r.u.span);
            const baseBytes = yield* baseBytesOf(r.base);
            const baseCost = current?.index.has(r.baseKey)
              ? 0
              : baseBytes.bytes.length;
            if (
              current === undefined ||
              (current.jobs.length > 0 &&
                current.bytes + delta.length + baseCost > batchBudget)
            ) {
              current = {
                bases: [],
                index: new Map(),
                jobs: [],
                items: [],
                bytes: 0,
              };
              batches.push(current);
            }
            let baseIndex = current.index.get(r.baseKey);
            if (baseIndex === undefined) {
              baseIndex = current.bases.push(baseBytes) - 1;
              current.index.set(r.baseKey, baseIndex);
              current.bytes += baseBytes.bytes.length;
            }
            current.jobs.push({
              id: current.jobs.length,
              type: r.base.type,
              base: baseIndex,
              delta,
            });
            current.items.push(r);
            current.bytes += delta.length;
          }
          const resolved = yield* Effect.all(
            batches.map((batch) =>
              hasher
                .resolveDeltas(batch.bases, batch.jobs, {
                  maxObjectSize: MAX_OBJECT_SIZE,
                })
                .pipe(
                  Effect.catchTag("HashError", (error) => {
                    console.warn(`[pump] ${error.reason}; resolving inline`);
                    return PartialScan.resolveDeltas(batch.bases, batch.jobs, {
                      maxObjectSize: MAX_OBJECT_SIZE,
                    });
                  }),
                  Effect.mapError(asIngest),
                  Effect.map((results) => ({ batch, results })),
                ),
            ),
            { concurrency: hasher.concurrency ?? HASH_CONCURRENCY },
          );
          for (const { batch, results } of resolved) {
            const incoming: Array<Incoming> = [];
            for (const result of results) {
              const r = batch.items[result.id]!;
              const item: Known = {
                oid: result.oid,
                type: r.base.type,
                dataOffset: r.u.dataOffset,
                span: r.u.span,
                zdata: result.zdata,
                content: result.content,
              };
              known.set(r.u.offset, item);
              knownByOid.set(result.oid, item);
              incoming.push({
                oid: result.oid,
                type: r.base.type,
                size: result.size,
                zdata: result.zdata,
                span: r.u.span,
                dataOffset: r.u.dataOffset,
                fromDelta: true,
                content: result.content,
              });
            }
            yield* stage(incoming);
          }
          pending = next;
        }
        phases.deltas = Date.now() - deltasStarted;
        const late = yield* writeResolvedPack("-r2");
        yield* flush();
        for (const pending of [early, late]) {
          if (pending === undefined) continue;
          yield* Fiber.join(pending.writing);
          phases.resolvedPack = Math.max(
            phases.resolvedPack ?? 0,
            Date.now() - pending.writeStarted,
          );
        }
        // Settle the spill: every part was written by its hasher; complete
        // the object and hand it to the source as the fallback reader.
        if (upload !== undefined && spill !== undefined) {
          const settled = upload;
          const uploaded: Array<UploadedPart> = [];
          for (const part of parts) uploaded.push(yield* part);
          yield* settled.complete(uploaded).pipe(
            Effect.mapError(
              (error) =>
                new PackIngestError({
                  reason: `spill complete: ${error.reason}`,
                }),
            ),
            Effect.provide(RuntimeContext.phantom),
          );
          spill.feeder.setFallback(
            blobRandomAccess({
              blobs: spill.blobs,
              key: spill.key,
              size: yield* spill.feeder.source.awaitEnd.pipe(
                Effect.mapError(asIngest),
              ),
            }),
          );
          parkedKey = spill.key;
        }
        return { count };
      }).pipe(
        // A failed ingest must not leave a dangling multipart upload —
        // R2 bills incomplete uploads until aborted or lifecycle-expired.
        Effect.onError(() =>
          Effect.suspend(() =>
            upload === undefined || parkedKey !== undefined
              ? Effect.void
              : upload.abort.pipe(Effect.provide(RuntimeContext.phantom)),
          ).pipe(Effect.ignore),
        ),
        Effect.onError(() =>
          Effect.suspend(() =>
            resolvedKeys.length === 0 || options.spill === undefined
              ? Effect.void
              : options.spill.blobs
                  .delete([...resolvedKeys])
                  .pipe(Effect.provide(RuntimeContext.phantom)),
          ).pipe(Effect.ignore),
        ),
      );

    const summary =
      options.hasher !== undefined
        ? yield* pumpThroughHasher(options.hasher)
        : yield* PackParser.ingestPack({
            source,
            store,
            maxObjectSize: MAX_OBJECT_SIZE,
            phases,
            sink: (entry) => stage([entry]),
            sinkBatch: stage,
          }).pipe(
            Effect.mapError((error) =>
              error._tag === "StoreError" || error._tag === "PackIngestError"
                ? error
                : new PackIngestError({ reason: packParserReason(error) }),
            ),
          );

    yield* flush();
    if (store.settle !== undefined) {
      const at = yield* Effect.sync(() => performance.now());
      yield* store.settle;
      stageMs += yield* Effect.sync(() => performance.now() - at);
    }

    return {
      stageMs,
      phases,
      promoted,
      parkedKey,
      resolvedKey,
      objectCount: summary.count,
      // The parser verifies the trailer itself; the checksum is not used
      // downstream, so it is not re-derived here.
      packSha: "",
      commits,
      // The connectivity check (DESIGN §22.14) needs only the edges that
      // leave the push: everything staged here is known present.
      referenced: Array.from(referenced).filter((oid) => !stagedOids.has(oid)),
      referencedParents: Array.from(referencedParents).filter(
        (oid) => !stagedOids.has(oid),
      ),
    } satisfies IngestResult;
  });

/** Renders a `PackParser` failure as an in-band `unpack <reason>` string. */
const packParserReason = (error: {
  readonly _tag: string;
  readonly reason?: string;
  readonly expected?: string;
  readonly actual?: string;
  readonly baseOid?: string;
  readonly size?: number;
  readonly limit?: number;
}): string => {
  switch (error._tag) {
    case "PackChecksumMismatch":
      return "pack checksum mismatch";
    case "MissingDeltaBaseError":
      return `missing delta base ${error.baseOid ?? ""}`.trim();
    case "ObjectTooLargeError":
      return `object too large (${error.size ?? 0} > ${error.limit ?? 0})`;
    default:
      return error.reason ?? error._tag;
  }
};

export const ingestPack = (
  pack: Uint8Array,
  options: Omit<IngestOptions, "store"> & { readonly store: ObjectStore },
): Effect.Effect<IngestResult, PackIngestError | StoreError> =>
  Effect.gen(function* () {
    const { store, pushId } = options;
    if (pack.length < 12 + 20) {
      return yield* new PackIngestError({ reason: "pack too small" });
    }
    if (
      pack[0] !== 0x50 ||
      pack[1] !== 0x41 ||
      pack[2] !== 0x43 ||
      pack[3] !== 0x4b
    ) {
      return yield* new PackIngestError({ reason: "bad pack signature" });
    }
    const view = new DataView(pack.buffer, pack.byteOffset, pack.byteLength);
    const version = view.getUint32(4);
    if (version !== 2) {
      return yield* new PackIngestError({
        reason: `unsupported pack version ${version}`,
      });
    }
    const count = view.getUint32(8);

    // Trailer verification first — cheap, and everything after assumes an
    // intact buffer.
    const trailer = bytesToHex(pack.subarray(pack.length - 20));
    const sha = makeSha1();
    sha.update(pack.subarray(0, pack.length - 20));
    const actual = sha.digestHex();
    if (actual !== trailer) {
      return yield* new PackIngestError({ reason: "pack checksum mismatch" });
    }

    const cache = makeContentCache(CACHE_BUDGET);
    const entries: Array<RawEntry> = [];
    const byOffset = new Map<number, RawEntry>();
    const byOid = new Map<Oid, RawEntry>();

    const commits: Array<StagedCommitInfo> = [];
    const referenced = new Set<Oid>();
    const referencedParents = new Set<Oid>();

    /** Record graph facts + referenced edges for a resolved object. */
    const recordObject = Effect.fn(function* (
      oid: Oid,
      type: ObjectType,
      content: Uint8Array,
    ) {
      switch (type) {
        case ObjectType.commit: {
          const parsed = yield* parseCommit(content).pipe(
            Effect.mapError(
              (error) =>
                new PackIngestError({
                  reason: `bad commit ${oid}: ${error.reason}`,
                }),
            ),
          );
          commits.push({
            oid,
            tree: parsed.tree,
            parents: parsed.parents,
            commitTime: parsed.committer.when,
          });
          referenced.add(parsed.tree);
          for (const parent of parsed.parents) {
            referencedParents.add(parent);
          }
          return;
        }
        case ObjectType.tree: {
          const parsed = yield* parseTree(content).pipe(
            Effect.mapError(
              (error) =>
                new PackIngestError({
                  reason: `bad tree ${oid}: ${error.reason}`,
                }),
            ),
          );
          for (const entry of parsed) {
            if (treeEntryKind(entry.mode) !== "commit") {
              referenced.add(entry.oid);
            }
          }
          return;
        }
        case ObjectType.tag: {
          const parsed = yield* parseTag(content).pipe(
            Effect.mapError(
              (error) =>
                new PackIngestError({
                  reason: `bad tag ${oid}: ${error.reason}`,
                }),
            ),
          );
          referenced.add(parsed.object);
          return;
        }
        case ObjectType.blob:
          return;
      }
    });

    const stage = Effect.fn(function* (
      oid: Oid,
      type: ObjectType,
      content: Uint8Array,
      zdata: Uint8Array,
    ) {
      const staged: StagedObject = {
        oid,
        type,
        size: content.length,
        zdata,
      };
      yield* store.insertStaged(pushId, staged);
      yield* recordObject(oid, type, content);
    });

    // ── Pass 1: scan entries, stage non-deltas verbatim ─────────────────────
    let offset = 12;
    const zlibToIngest = (error: Zlib.ZlibError): PackIngestError =>
      new PackIngestError({ reason: error.reason });

    for (let i = 0; i < count; i++) {
      const entryStart = offset;
      let header;
      try {
        header = decodeTypeSize(pack, offset);
      } catch (error) {
        return yield* new PackIngestError({
          reason: `entry ${i}: ${String(error)}`,
        });
      }
      if (!isDeltaType(header.type)) {
        if (header.size > MAX_OBJECT_SIZE) {
          return yield* new PackIngestError({ reason: "object too large" });
        }
        const inflated = yield* Zlib.inflateEntry(pack, header.next, {
          maxOutput: header.size,
        }).pipe(Effect.mapError(zlibToIngest));
        if (inflated.content.length !== header.size) {
          return yield* new PackIngestError({
            reason: `entry ${i}: size mismatch (${inflated.content.length} != ${header.size})`,
          });
        }
        const type = header.type as ObjectType;
        const oid = yield* hashObject(type, inflated.content);
        const zdata = pack.subarray(
          header.next,
          header.next + inflated.bytesConsumed,
        );
        const entry: RawEntry = {
          offset: entryStart,
          kind: "object",
          type,
          declaredSize: header.size,
          zstart: header.next,
          zlen: inflated.bytesConsumed,
          baseOffset: undefined,
          baseOid: undefined,
          oid,
          resolvedType: type,
        };
        entries.push(entry);
        byOffset.set(entryStart, entry);
        byOid.set(oid, entry);
        cache.set(oid, inflated.content);
        yield* stage(oid, type, inflated.content, zdata);
        offset = header.next + inflated.bytesConsumed;
      } else {
        let zstart = header.next;
        let baseOffset: number | undefined;
        let baseOid: Oid | undefined;
        if (header.type === 6) {
          let decoded;
          try {
            decoded = decodeOfsDeltaOffset(pack, header.next);
          } catch (error) {
            return yield* new PackIngestError({
              reason: `entry ${i}: ${String(error)}`,
            });
          }
          baseOffset = entryStart - decoded.value;
          if (baseOffset < 12) {
            return yield* new PackIngestError({
              reason: `entry ${i}: ofs-delta base offset out of range`,
            });
          }
          zstart = decoded.next;
        } else {
          if (header.next + 20 > pack.length) {
            return yield* new PackIngestError({
              reason: `entry ${i}: truncated ref-delta base id`,
            });
          }
          baseOid = bytesToHex(pack.subarray(header.next, header.next + 20));
          zstart = header.next + 20;
        }
        const inflated = yield* Zlib.inflateEntry(pack, zstart, {
          maxOutput: header.size,
        }).pipe(Effect.mapError(zlibToIngest));
        const entry: RawEntry = {
          offset: entryStart,
          kind: header.type === 6 ? "ofs" : "ref",
          type: undefined,
          declaredSize: header.size,
          zstart,
          zlen: inflated.bytesConsumed,
          baseOffset,
          baseOid,
          oid: undefined,
          resolvedType: undefined,
        };
        entries.push(entry);
        byOffset.set(entryStart, entry);
        offset = zstart + inflated.bytesConsumed;
      }
      if (offset > pack.length - 20) {
        return yield* new PackIngestError({
          reason: `entry ${i}: pack truncated`,
        });
      }
    }
    if (offset !== pack.length - 20) {
      return yield* new PackIngestError({
        reason: "trailing garbage between entries and pack trailer",
      });
    }

    // ── Pass 2: resolve deltas (bases may chain; thin bases from store) ─────
    const contentOf = (
      entry: RawEntry,
      depth: number,
    ): Effect.Effect<
      { readonly content: Uint8Array; readonly type: ObjectType },
      PackIngestError | StoreError
    > =>
      Effect.gen(function* () {
        if (depth > MAX_DELTA_DEPTH) {
          return yield* new PackIngestError({ reason: "delta chain too deep" });
        }
        if (entry.oid !== undefined && entry.resolvedType !== undefined) {
          const cached = cache.get(entry.oid);
          if (cached !== undefined) {
            return { content: cached, type: entry.resolvedType };
          }
        }
        if (entry.kind === "object") {
          const inflated = yield* Zlib.inflateEntry(pack, entry.zstart, {
            maxOutput: entry.declaredSize,
          }).pipe(Effect.mapError(zlibToIngest));
          if (entry.oid !== undefined) cache.set(entry.oid, inflated.content);
          return { content: inflated.content, type: entry.type! };
        }
        // delta — resolve the base first
        const base = yield* Effect.gen(function* () {
          if (entry.kind === "ofs") {
            const baseEntry = byOffset.get(entry.baseOffset!);
            if (baseEntry === undefined) {
              return yield* new PackIngestError({
                reason: "ofs-delta base is not an entry boundary",
              });
            }
            return yield* contentOf(baseEntry, depth + 1);
          }
          const inPack = byOid.get(entry.baseOid!);
          if (inPack !== undefined) {
            return yield* contentOf(inPack, depth + 1);
          }
          // Thin base: must exist in the live store.
          const meta = yield* store.getMeta(entry.baseOid!);
          if (meta === undefined) {
            return yield* new PackIngestError({
              reason: `missing thin-pack base ${entry.baseOid}`,
            });
          }
          if (meta.size > MAX_OBJECT_SIZE) {
            return yield* new PackIngestError({ reason: "object too large" });
          }
          const content = yield* store.readContent(entry.baseOid!);
          cache.set(entry.baseOid!, content);
          return { content, type: meta.type };
        });
        const delta = yield* Zlib.inflateEntry(pack, entry.zstart, {
          maxOutput: entry.declaredSize,
        }).pipe(Effect.mapError(zlibToIngest));
        const content = yield* applyDelta(base.content, delta.content).pipe(
          Effect.mapError(
            (error) => new PackIngestError({ reason: error.reason }),
          ),
        );
        if (content.length > MAX_OBJECT_SIZE) {
          return yield* new PackIngestError({ reason: "object too large" });
        }
        return { content, type: base.type };
      });

    for (const entry of entries) {
      if (entry.kind === "object" || entry.oid !== undefined) continue;
      const resolved = yield* contentOf(entry, 0);
      const oid = yield* hashObject(resolved.type, resolved.content);
      entry.oid = oid;
      entry.resolvedType = resolved.type;
      byOid.set(oid, entry);
      cache.set(oid, resolved.content);
      const zdata = yield* Zlib.deflate(resolved.content).pipe(
        Effect.mapError(zlibToIngest),
      );
      yield* stage(oid, resolved.type, resolved.content, zdata);
    }

    return {
      objectCount: count,
      packSha: trailer,
      commits,
      referenced: Array.from(referenced),
      referencedParents: Array.from(referencedParents),
    } satisfies IngestResult;
  });

// ─────────────────────────────────────────────────────────────────────────────
// Small shared helpers
// ─────────────────────────────────────────────────────────────────────────────

const asOid = (s: string): ApiOid => s as ApiOid;

/** A node of the merge-base paint walk's max-heap (gen desc, time desc). */
export interface WalkHeapNode {
  readonly oid: string;
  readonly gen: number;
  readonly time: number;
}

const heapBefore = (a: WalkHeapNode, b: WalkHeapNode): boolean =>
  a.gen !== b.gen ? a.gen > b.gen : a.time > b.time;

/** Pushes onto a binary max-heap keyed `(gen desc, commit_time desc)`. */
export const heapPush = (
  heap: Array<WalkHeapNode>,
  node: WalkHeapNode,
): void => {
  heap.push(node);
  let i = heap.length - 1;
  while (i > 0) {
    const parent = (i - 1) >> 1;
    if (!heapBefore(heap[i]!, heap[parent]!)) break;
    const tmp = heap[parent]!;
    heap[parent] = heap[i]!;
    heap[i] = tmp;
    i = parent;
  }
};

/** Pops the max node. Callers must check `heap.length > 0` first. */
export const heapPop = (heap: Array<WalkHeapNode>): WalkHeapNode => {
  const top = heap[0]!;
  const last = heap.pop()!;
  if (heap.length > 0) {
    heap[0] = last;
    let i = 0;
    for (;;) {
      const left = 2 * i + 1;
      const right = left + 1;
      let max = i;
      if (left < heap.length && heapBefore(heap[left]!, heap[max]!)) {
        max = left;
      }
      if (right < heap.length && heapBefore(heap[right]!, heap[max]!)) {
        max = right;
      }
      if (max === i) break;
      const tmp = heap[max]!;
      heap[max] = heap[i]!;
      heap[i] = tmp;
      i = max;
    }
  }
  return top;
};

/** Decompresses a request body when it is gzip (header or 1f8b sniff). */
export const gunzipIfNeeded = (
  body: Uint8Array,
  contentEncoding: string | undefined,
): Effect.Effect<Uint8Array, PackIngestError> => {
  const looksGzip = body.length >= 2 && body[0] === 0x1f && body[1] === 0x8b;
  if (contentEncoding?.toLowerCase() !== "gzip" && !looksGzip) {
    return Effect.succeed(body);
  }
  if (!looksGzip) {
    // Content-Encoding claimed gzip but the magic disagrees — trust bytes.
    return Effect.succeed(body);
  }
  return Effect.tryPromise({
    try: () =>
      new Response(
        new Response(body as BodyInit).body!.pipeThrough(
          new DecompressionStream("gzip"),
        ),
      )
        .arrayBuffer()
        .then((buffer) => new Uint8Array(buffer)),
    catch: (error) =>
      new PackIngestError({ reason: `gzip decompression failed: ${error}` }),
  });
};

const noCache = { "cache-control": "no-cache" } as const;

// ─────────────────────────────────────────────────────────────────────────────
// The Durable Object
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The per-repo Durable Object class (modular form). The runtime
 * implementation is {@link GitRepoLive}; the hosting Worker provides it via
 * `Effect.provide(GitRepoLive)` and consumers `yield* GitRepo` for the
 * namespace handle.
 */
export class GitRepo extends Cloudflare.DurableObject<GitRepo, GitRepoShape>()(
  "GitRepo",
  {
    // Every tagged error the RPC surface can fail with: the calling Worker
    // reconstructs real class instances from the RPC wire (see the
    // `DurableObjectProps.errors` doc), so catchTag/instanceof/HttpApi
    // encoding all see the classes the DO actually failed with.
    errors: [
      ReadOnlyRepo,
      RepoNotFound,
      RefNotFound,
      RefConflict,
      ObjectNotFound,
      WrongObjectType,
      NoMergeBase,
      PullNotFound,
      PullExists,
      PullStateConflict,
      BranchMissing,
      NothingToMerge,
      MergeConflict,
      ValidationError,
      StoreError,
      PackIngestError,
      WireProtocolError,
    ],
  },
) {}

/**
 * A repository's RPC stub: {@link GitRepoShape} as the Worker calls it,
 * with `fetch` taking the request.
 */
export type RepoStub = ReturnType<
  Cloudflare.Workers.DurableObject<GitRepoShape>["getByName"]
>;

/** What {@link RepoStore} provides: a repository's stub by id. */
export interface RepoStoreShape {
  /** The repository's stub, by its registry id (a ULID). */
  readonly getByName: (repoId: string) => RepoStub;
}

/**
 * `Git.RepoStore` — the repository block as a service: every route reaches
 * a repository through it. `ReposDurableObject` provides it over the
 * {@link GitRepo} Durable Object namespace. It is the seam for decorating
 * repositories (hook `commitPush`, `updateRef`, `mergePull` to observe ref
 * moves) or for implementing {@link GitRepoShape} over another store.
 *
 * @binding
 */
export class RepoStore extends Context.Service<RepoStore, RepoStoreShape>()(
  "alchemy/Git/RepoStore",
) {}

/**
 * The Repo DO implementation Layer. Requires the {@link BlobStore}
 * service (provide `Git.BlobStoreR2(yourBucket)` — or any other
 * implementation — in the same layer graph) and the {@link Registry}
 * namespace.
 */
export const GitRepoLive = GitRepo.make(
  Effect.gen(function* () {
    // ── Outer init: resolve bindings + namespaces (runs at plan time too) ──
    const state = yield* Cloudflare.DurableObjectState;
    // The building-blocks seam: bulk bytes live behind whatever BlobStore
    // the user's layer graph provides (R2 by default, S3, ...).
    const blobs: BlobStoreShape = yield* BlobStore;
    // The push pipeline's hasher (DESIGN §22.7): a self-binding fan-out in
    // production, in-process in tests without the binding.
    const hasher = yield* Hasher;
    const registry = yield* RegistryStore;
    const selfNamespace = yield* Cloudflare.DurableObjectScope;

    return Effect.gen(function* () {
      // ── Inner init: per-instance construction (runtime only) ────────────
      const sql = makeSqlClient(state);
      yield* initRepoSchema(sql).pipe(Effect.orDie);
      // Isolate-wide, not per repo: the memory it meters is shared.
      const pushSemaphore = yield* isolatePushGate;

      // ── config helpers ───────────────────────────────────────────────────
      const getConfig = (key: string) =>
        sql
          .first<{ value: string }>(
            `SELECT value FROM config WHERE key = ?`,
            key,
          )
          .pipe(Effect.map((row) => row?.value));

      const setConfig = (key: string, value: string) =>
        sql.run(
          `INSERT INTO config (key, value) VALUES (?, ?)
           ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
          key,
          value,
        );

      /**
       * Repo metadata from the `config` table. The `objects` breakdown is
       * a GROUP BY over the whole `objects` table — on a large repo that
       * scan walks pages dense with inline zdata and was measured at
       * ~1.5 s per call (DESIGN §22). It is therefore opt-in: only the
       * REST repo-detail responses pay for it; the wire path, auth, and
       * every other caller get zeros there and never touch the table.
       */
      const readMetaWith = (
        withStats: boolean,
      ): Effect.Effect<RepoMetaData | undefined, StoreError> =>
        Effect.gen(function* () {
          const rows = yield* sql.all<{ key: string; value: string }>(
            `SELECT key, value FROM config`,
          );
          const map = new Map(rows.map((row) => [row.key, row.value]));
          const repoId = map.get("repo_id");
          if (repoId === undefined) return undefined;
          const stats = withStats
            ? yield* sql.all<{
                bucket: string;
                n: number;
                bytes: number;
              }>(
                // Row-resident blobs are "loose" (awaiting compaction);
                // row-resident commits/trees/tags are "resident" — they stay
                // in SQLite for the life of the repo (Compact.ts BLOB_TYPE).
                `SELECT CASE WHEN location = 'row' AND type <> 3 THEN 'resident'
                             WHEN location = 'row' THEN 'loose'
                             ELSE location END AS bucket,
                        COUNT(*) AS n, COALESCE(SUM(zsize), 0) AS bytes
                   FROM objects WHERE ${LIVE_OBJECTS} GROUP BY bucket`,
              )
            : [];
          const byLocation = new Map(stats.map((row) => [row.bucket, row]));
          return {
            repoId,
            owner: map.get("owner") ?? "",
            name: map.get("name") ?? "",
            defaultBranch: map.get("default_branch") ?? "main",
            description: map.get("description") ?? null,
            readOnly: map.get("read_only") === "1",
            public: map.get("public") === "1",
            forkOf: map.get("fork_of") ?? null,
            status: (map.get("status") ?? "ready") as RepoStatus,
            createdAt: Number(map.get("created_at") ?? 0),
            lastPush:
              map.get("last_push") === undefined
                ? null
                : (JSON.parse(map.get("last_push")!) as PushStatsData),
            objects: {
              loose: byLocation.get("loose")?.n ?? 0,
              resident: byLocation.get("resident")?.n ?? 0,
              packed: byLocation.get("pack")?.n ?? 0,
              r2: byLocation.get("r2")?.n ?? 0,
              bytes: stats.reduce((sum, row) => sum + row.bytes, 0),
            },
          } satisfies RepoMetaData;
        });

      const readMeta = readMetaWith(false);
      const readMetaStats = readMetaWith(true);

      const requireFrom = (
        read: Effect.Effect<RepoMetaData | undefined, StoreError>,
      ): Effect.Effect<RepoMetaData, RepoNotFound | StoreError> =>
        read.pipe(
          Effect.flatMap((meta) =>
            meta === undefined
              ? Effect.fail(new RepoNotFound({ owner: "", repo: "" }))
              : Effect.succeed(meta),
          ),
        );
      /** Cheap: config only. `objects` reads as zeros. */
      const requireMeta = requireFrom(readMeta);
      /** The REST detail shape, with the full objects aggregate. */
      const requireMetaStats = requireFrom(readMetaStats);

      /** The object store, keyed by the current repoId. */
      const storeFor = (repoId: string): ObjectStore =>
        makeObjectStore({ sql, blobs, repoId });

      // ── refs ─────────────────────────────────────────────────────────────
      /** Peels a (possibly annotated-tag) oid to its final non-tag target. */
      const peelOid = (
        repoId: string,
        oid: Oid,
      ): Effect.Effect<Oid | undefined, StoreError> =>
        Effect.gen(function* () {
          const objects = storeFor(repoId);
          let current = oid;
          for (let hops = 0; hops < 16; hops++) {
            const meta = yield* objects.getMeta(current);
            if (meta === undefined) return undefined;
            if (meta.type !== ObjectType.tag) {
              return hops === 0 ? undefined : current;
            }
            const content = yield* objects.readContent(current);
            const parsed = yield* parseTag(content).pipe(
              Effect.mapError(
                (error) => new StoreError({ reason: error.reason }),
              ),
            );
            current = parsed.object;
          }
          return current;
        });

      /**
       * Resolves a refname (short or full) or 40-hex oid to an object oid.
       * Candidates for short names: `refs/heads/<name>`, `refs/tags/<name>`.
       * `undefined` means HEAD (the default branch).
       */
      const resolveRevision = Effect.fn(function* (
        defaultBranch: string,
        rev: string | undefined,
      ) {
        const refName = rev === undefined ? `refs/heads/${defaultBranch}` : rev;
        if (isOid(refName)) return refName;
        const candidates = refName.startsWith("refs/")
          ? [refName]
          : [`refs/heads/${refName}`, `refs/tags/${refName}`];
        for (const candidate of candidates) {
          const row = yield* sql.first<RefRow>(
            `SELECT name, oid FROM refs WHERE name = ?`,
            candidate,
          );
          if (row !== undefined) return row.oid;
        }
        return yield* new RefNotFound({ ref: refName });
      });

      /** Resolves a revision all the way to a COMMIT oid (peels tags). */
      const resolveToCommit = Effect.fn(function* (
        repoId: string,
        defaultBranch: string,
        rev: string,
      ) {
        const oid = yield* resolveRevision(defaultBranch, rev);
        const objects = storeFor(repoId);
        const meta = yield* objects.getMeta(oid);
        if (meta === undefined) return yield* new ObjectNotFound({ oid });
        if (meta.type === ObjectType.commit) return oid;
        if (meta.type === ObjectType.tag) {
          const peeled = yield* peelOid(repoId, oid);
          if (peeled === undefined) {
            return yield* new ObjectNotFound({ oid });
          }
          const peeledMeta = yield* objects.getMeta(peeled);
          if (peeledMeta === undefined) {
            return yield* new ObjectNotFound({ oid: peeled });
          }
          if (peeledMeta.type !== ObjectType.commit) {
            return yield* new WrongObjectType({
              oid: peeled,
              expected: "commit",
              actual: objectTypeName(peeledMeta.type),
            });
          }
          return peeled;
        }
        return yield* new WrongObjectType({
          oid,
          expected: "commit",
          actual: objectTypeName(meta.type),
        });
      });

      const listAllRefs = (
        repoId: string,
        prefix?: string | undefined,
      ): Effect.Effect<Array<RefData>, StoreError> =>
        Effect.gen(function* () {
          const rows =
            prefix === undefined || prefix.length === 0
              ? yield* sql.all<RefRow>(
                  `SELECT name, oid FROM refs ORDER BY name`,
                )
              : yield* sql.all<RefRow>(
                  `SELECT name, oid FROM refs WHERE name >= ? AND name < ? ORDER BY name`,
                  prefix,
                  // next lexicographic sibling of the prefix
                  `${prefix.slice(0, -1)}${String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1)}`,
                );
          const out: Array<RefData> = [];
          for (const row of rows) {
            const peeled = row.name.startsWith("refs/tags/")
              ? yield* peelOid(repoId, row.oid)
              : undefined;
            out.push(
              peeled === undefined
                ? { name: row.name, oid: row.oid }
                : { name: row.name, oid: row.oid, peeled },
            );
          }
          return out;
        });

      /**
       * The single transactional ref-CAS path (DESIGN.md §3.4). All ref
       * mutations — push commands, REST writes, import finalize — run here.
       */
      interface RefResult {
        readonly ref: string;
        readonly ok: boolean;
        readonly reason?: string | undefined;
      }
      const finalizeRefTxn = (options: {
        readonly commands: ReadonlyArray<RefCommand>;
        readonly atomic: boolean;
        /** Skip the old-oid CAS entirely (import finalize). */
        readonly unconditional?: boolean | undefined;
        readonly pushId?: string | undefined;
        /** Leave the per-row `staged_push` rewrite to `flipPush` (after the response). */
        readonly deferFlip?: boolean | undefined;
        readonly graph: ReadonlyArray<{
          readonly oid: string;
          readonly tree: string;
          readonly gen: number;
          readonly commitTime: number;
          readonly parents: ReadonlyArray<string>;
        }>;
        /**
         * Extra statements run inside the transaction body, only when at
         * least one command succeeded (right after the graph inserts) —
         * e.g. the PR merge stamps its pulls row atomically with the ref
         * flip and the staged-object promotion. MUST be fully synchronous.
         */
        readonly onCommitted?: ((raw: cf.SqlStorage) => void) | undefined;
      }): Effect.Effect<Array<RefResult>, StoreError, RuntimeContext> =>
        sql
          .transactionSync((raw) => {
            if (options.pushId !== undefined) {
              const push = raw
                .exec<{ state: string }>(
                  `SELECT state FROM pushes WHERE push_id = ?`,
                  options.pushId,
                )
                .toArray()[0];
              if (push?.state !== "staging")
                return options.commands.map((command) => ({
                  ref: command.ref,
                  ok: false,
                  reason: "push is no longer active",
                }));
            }
            const currentOf = (name: string): string => {
              const rows = raw
                .exec<RefRow>(`SELECT name, oid FROM refs WHERE name = ?`, name)
                .toArray();
              return rows.length > 0 ? rows[0]!.oid : ZERO_OID;
            };
            const results: Array<RefResult> = [];
            // atomic: verify every CAS before writing anything
            if (options.atomic && options.unconditional !== true) {
              const failed = options.commands.some(
                (cmd) => currentOf(cmd.ref) !== cmd.oldOid,
              );
              if (failed) {
                for (const cmd of options.commands) {
                  results.push({
                    ref: cmd.ref,
                    ok: false,
                    reason:
                      currentOf(cmd.ref) === cmd.oldOid
                        ? "atomic transaction failed"
                        : "fetch first",
                  });
                }
                return results;
              }
            }
            let anyOk = false;
            for (const cmd of options.commands) {
              if (
                options.unconditional !== true &&
                currentOf(cmd.ref) !== cmd.oldOid
              ) {
                results.push({
                  ref: cmd.ref,
                  ok: false,
                  reason: "fetch first",
                });
                continue;
              }
              if (cmd.newOid === ZERO_OID) {
                raw.exec(`DELETE FROM refs WHERE name = ?`, cmd.ref);
              } else {
                raw.exec(
                  `INSERT INTO refs (name, oid) VALUES (?, ?)
                 ON CONFLICT (name) DO UPDATE SET oid = excluded.oid`,
                  cmd.ref,
                  cmd.newOid,
                );
              }
              results.push({ ref: cmd.ref, ok: true });
              anyOk = true;
            }
            if (anyOk || options.commands.length === 0) {
              if (options.pushId !== undefined) {
                // Committing the push row is what makes its objects live
                // (LIVE_OBJECTS, DESIGN §22.14); nulling `staged_push` on
                // every row is a rewrite of the whole staged set and runs
                // after the response (`flipPush`), or inside this
                // transaction for callers that want it settled now.
                if (options.deferFlip !== true) {
                  raw.exec(
                    `UPDATE objects SET staged_push = NULL WHERE staged_push = ?`,
                    options.pushId,
                  );
                }
                raw.exec(
                  `UPDATE pushes SET state = 'committed' WHERE push_id = ?`,
                  options.pushId,
                );
              }
              // Multi-row inserts under SQLite's 100-parameter cap: a
              // per-row exec was most of finalize once rows were
              // coordinates (DESIGN §22.14).
              for (let at = 0; at < options.graph.length; at += 25) {
                const part = options.graph.slice(at, at + 25);
                raw.exec(
                  `INSERT OR IGNORE INTO commits (oid, tree, gen, commit_time) VALUES ${part.map(() => "(?, ?, ?, ?)").join(", ")}`,
                  ...part.flatMap((commit) => [
                    commit.oid,
                    commit.tree,
                    commit.gen,
                    commit.commitTime,
                  ]),
                );
              }
              const parentRows = options.graph.flatMap((commit) =>
                commit.parents.map((parent, ord) => [commit.oid, parent, ord]),
              );
              for (let at = 0; at < parentRows.length; at += 33) {
                const part = parentRows.slice(at, at + 33);
                raw.exec(
                  `INSERT OR IGNORE INTO commit_parents (oid, parent, ord) VALUES ${part.map(() => "(?, ?, ?)").join(", ")}`,
                  ...part.flat(),
                );
              }
              if (options.onCommitted !== undefined) {
                options.onCommitted(raw);
              }
              // First-branch-push default branch fixup: if the configured
              // default branch does not exist but a branch was just created,
              // repoint the default at it (prefer main/master).
              const configured = raw
                .exec<{ value: string }>(
                  `SELECT value FROM config WHERE key = 'default_branch'`,
                )
                .toArray()[0]?.value;
              if (configured !== undefined) {
                const exists = raw
                  .exec<RefRow>(
                    `SELECT name, oid FROM refs WHERE name = ?`,
                    `refs/heads/${configured}`,
                  )
                  .toArray();
                if (exists.length === 0) {
                  const branches = raw
                    .exec<RefRow>(
                      `SELECT name, oid FROM refs WHERE name LIKE 'refs/heads/%' ORDER BY name`,
                    )
                    .toArray()
                    .map((row) => row.name.slice("refs/heads/".length));
                  const pick =
                    branches.find((b) => b === "main") ??
                    branches.find((b) => b === "master") ??
                    branches[0];
                  if (pick !== undefined) {
                    raw.exec(
                      `UPDATE config SET value = ? WHERE key = 'default_branch'`,
                      pick,
                    );
                  }
                }
              }
            }
            return results;
          })
          .pipe(
            // Any committed ref movement changes what an anonymous reader
            // can see — republish the head snapshot (DESIGN.md §21).
            Effect.tap((results) =>
              results.some((result) => result.ok)
                ? writeHeadSnapshot
                : Effect.void,
            ),
          );

      /** Computes gen/commit_time rows for staged commits (§3.6 step 6). */
      const computeGraphRows = (
        staged: ReadonlyArray<StagedCommitInfo>,
      ): Effect.Effect<
        Array<{
          oid: string;
          tree: string;
          gen: number;
          commitTime: number;
          parents: ReadonlyArray<string>;
        }>,
        StoreError
      > =>
        Effect.gen(function* () {
          const stagedByOid = new Map(staged.map((c) => [c.oid, c]));
          const externalParents = Array.from(
            new Set(
              staged.flatMap((c) =>
                c.parents.filter((p) => !stagedByOid.has(p)),
              ),
            ),
          );
          const liveGens = new Map<string, number>();
          if (externalParents.length > 0) {
            const rows = yield* sql.inChunks<{ oid: string; gen: number }>(
              (ph) => `SELECT oid, gen FROM commits WHERE oid IN (${ph})`,
              externalParents,
            );
            for (const row of rows) liveGens.set(row.oid, row.gen);
          }
          const gens = new Map<string, number>();
          const genOf = (oid: string, depth: number): number => {
            const known = gens.get(oid);
            if (known !== undefined) return known;
            const live = liveGens.get(oid);
            if (live !== undefined) return live;
            const commit = stagedByOid.get(oid);
            // Missing parent (shallow boundary) counts as gen 0.
            if (commit === undefined || depth > 100_000) return 0;
            const gen =
              commit.parents.length === 0
                ? 1
                : Math.max(...commit.parents.map((p) => genOf(p, depth + 1))) +
                  1;
            gens.set(oid, gen);
            return gen;
          };
          return staged.map((commit) => ({
            oid: commit.oid,
            tree: commit.tree,
            gen: genOf(commit.oid, 0),
            commitTime: commit.commitTime,
            parents: commit.parents,
          }));
        });

      // ── pull requests ────────────────────────────────────────────────────

      /** `main` or `refs/heads/main` → `refs/heads/main`; branches only. */
      const normalizeBranchRef = Effect.fn(function* (name: string) {
        const full = name.startsWith("refs/") ? name : `refs/heads/${name}`;
        if (
          !full.startsWith("refs/heads/") ||
          full.length <= "refs/heads/".length ||
          !REF_NAME_REGEX.test(full)
        ) {
          return yield* new ValidationError({
            message: `not a branch name: ${name} (only refs/heads/* is legal)`,
          });
        }
        return full;
      });

      const pullStateOf = (state: string): "open" | "closed" | "merged" =>
        state === "closed" ? "closed" : state === "merged" ? "merged" : "open";

      const rowToPull = (row: PullRow): PullData => ({
        number: row.number,
        title: row.title,
        body: row.body,
        baseRef: row.base_ref,
        headRef: row.head_ref,
        state: pullStateOf(row.state),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        mergedAt: row.merged_at,
        mergeCommit: row.merge_commit,
      });

      const loadPull = Effect.fn(function* (number: number) {
        const row = yield* sql.first<PullRow>(
          `SELECT * FROM pulls WHERE number = ?`,
          number,
        );
        if (row === undefined) {
          return yield* new PullNotFound({ number });
        }
        return row;
      });

      /** Result of the bounded two-tip ancestor {@link paintWalk}. */
      interface PullCompare {
        /** Best common ancestor; `undefined` = none found (see saturated). */
        readonly mergeBase: string | undefined;
        /** Commits reachable from head but not base. */
        readonly aheadBy: number;
        /** Commits reachable from base but not head. */
        readonly behindBy: number;
        /** The walk hit its pop bound — counts/base are unreliable. */
        readonly saturated: boolean;
      }

      /**
       * The same gen-ordered merge-base paint walk `compareCommits` runs,
       * reduced to what the PR surface needs: the best common ancestor plus
       * ahead/behind counts. `mergeBase === head` ⇔ head is reachable from
       * base (up-to-date); `mergeBase === base` ⇔ base is reachable from
       * head (fast-forwardable) — the gen ordering guarantees a node's
       * flags are complete when it pops. A tip missing from the commit
       * graph reports `saturated` (uncomputable), never an error.
       */
      const paintWalk = Effect.fn(function* (
        baseOid: string,
        headOid: string,
        maxPops: number,
      ) {
        const BASE = 1;
        const HEAD = 2;
        const BOTH = 3;
        const flags = new Map<string, number>();
        flags.set(baseOid, BASE);
        flags.set(headOid, (flags.get(headOid) ?? 0) | HEAD);
        const heap: Array<WalkHeapNode> = [];
        const rowOf = (oid: string) =>
          sql.first<{ gen: number; commit_time: number }>(
            `SELECT gen, commit_time FROM commits WHERE oid = ?`,
            oid,
          );
        for (const oid of new Set([baseOid, headOid])) {
          const row = yield* rowOf(oid);
          if (row === undefined) {
            return {
              mergeBase: undefined,
              aheadBy: 0,
              behindBy: 0,
              saturated: true,
            } satisfies PullCompare;
          }
          heapPush(heap, { oid, gen: row.gen, time: row.commit_time });
        }
        let mergeBase: string | undefined;
        let aheadBy = 0;
        let behindBy = 0;
        let pops = 0;
        while (heap.length > 0 && pops < maxPops) {
          // stop once nothing in the heap can still change the counts
          if (
            mergeBase !== undefined &&
            heap.every((n) => (flags.get(n.oid)! & BOTH) === BOTH)
          ) {
            break;
          }
          const node = heapPop(heap);
          pops++;
          const f = flags.get(node.oid)!;
          if ((f & BOTH) === BOTH) {
            if (mergeBase === undefined) mergeBase = node.oid;
          } else if (f === HEAD) {
            aheadBy++;
          } else {
            behindBy++;
          }
          const parents = yield* sql.all<{ parent: string }>(
            `SELECT parent FROM commit_parents WHERE oid = ? ORDER BY ord`,
            node.oid,
          );
          for (const { parent } of parents) {
            const prev = flags.get(parent) ?? 0;
            const next = prev | f;
            if (next === prev) continue;
            flags.set(parent, next);
            if (prev === 0) {
              const row = yield* rowOf(parent);
              if (row === undefined) continue; // shallow boundary
              heapPush(heap, {
                oid: parent,
                gen: row.gen,
                time: row.commit_time,
              });
            }
          }
        }
        return {
          mergeBase,
          aheadBy,
          behindBy,
          saturated: pops >= maxPops && heap.length > 0,
        } satisfies PullCompare;
      });

      /** The root tree of a commit, via the commit-graph table. */
      const treeOfCommit = Effect.fn(function* (oid: string) {
        const row = yield* sql.first<{ tree: string }>(
          `SELECT tree FROM commits WHERE oid = ?`,
          oid,
        );
        if (row === undefined) {
          return yield* new StoreError({
            reason: `commit ${oid} missing from the commit graph`,
          });
        }
        return row.tree;
      });

      // ── alarm scheduling ─────────────────────────────────────────────────
      const armAlarmAt = (time: number) =>
        Effect.gen(function* () {
          const existing = yield* state.storage.getAlarm();
          if (existing === null || existing > time) {
            yield* state.storage.setAlarm(time);
          }
        });

      const upsertJob = (kind: string, detail: string | null) =>
        sql.run(
          `INSERT INTO jobs (kind, state, detail, updated_at) VALUES (?, 'running', ?, ?)
           ON CONFLICT (kind) DO UPDATE SET state = 'running', detail = excluded.detail, updated_at = excluded.updated_at`,
          kind,
          detail,
          Date.now(),
        );

      // ── bootstrap (create / fork / import) ───────────────────────────────
      const seedConfig = Effect.fn(function* (
        input: InitRepoInput,
        status: RepoStatus,
      ) {
        const createdAt = Date.now();
        yield* setConfig("repo_id", input.repoId);
        yield* setConfig("owner", input.owner.toLowerCase());
        yield* setConfig("name", input.name.toLowerCase());
        yield* setConfig("default_branch", input.defaultBranch);
        if (input.description !== null) {
          yield* setConfig("description", input.description);
        }
        yield* setConfig("read_only", input.readOnly ? "1" : "0");
        yield* setConfig("public", input.public ? "1" : "0");
        if (input.forkOf !== null) {
          yield* setConfig("fork_of", input.forkOf);
        }
        yield* setConfig("status", status);
        yield* readMeta.pipe(
          Effect.flatMap((meta) =>
            meta === undefined ? Effect.void : syncSummary(meta),
          ),
          Effect.ignore,
        );
        const existing = yield* getConfig("created_at");
        if (existing === undefined) {
          yield* setConfig("created_at", String(createdAt));
        }
        const meta = yield* readMeta;
        return meta!;
      });

      const bootstrap = Effect.fn(function* (
        input: InitRepoInput,
        status: RepoStatus,
      ) {
        const meta = yield* seedConfig(input, status);
        return { meta } satisfies InitRepoResult;
      });

      // ── wire protocol drivers ────────────────────────────────────────────

      /** Parses `/:owner/:repo[.git]/<endpoint>` out of the request URL. */
      const parseWirePath = (
        url: string,
      ):
        | {
            readonly owner: string;
            readonly repo: string;
            readonly endpoint: string;
            readonly service: string | undefined;
          }
        | undefined => {
        const parsed = new URL(url, "http://repo");
        const segments = parsed.pathname.split("/").filter(Boolean);
        if (segments.length < 3) return undefined;
        const owner = decodeURIComponent(segments[0]!).toLowerCase();
        let repo = decodeURIComponent(segments[1]!).toLowerCase();
        if (repo.endsWith(".git")) repo = repo.slice(0, -4);
        const endpoint = segments.slice(2).join("/");
        return {
          owner,
          repo,
          endpoint,
          service: parsed.searchParams.get("service") ?? undefined,
        };
      };

      const wire503 = HttpServerResponse.empty({
        status: 503,
        headers: { "retry-after": "10" },
      });

      /** GET info/refs — the v0 advertisement. */
      const handleInfoRefs = (
        request: HttpServerRequest.HttpServerRequest,
        service: string | undefined,
        meta: RepoMetaData,
      ) =>
        Effect.gen(function* () {
          if (service !== "git-upload-pack" && service !== "git-receive-pack") {
            return HttpServerResponse.text(
              "smart HTTP only (dumb protocol not supported)",
              { status: 400 },
            );
          }
          const refs = yield* listAllRefs(meta.repoId);
          const body = buildAdvertisement({
            service,
            defaultBranch: meta.defaultBranch,
            refs,
          });
          return HttpServerResponse.uint8Array(body, {
            contentType: `application/x-${service}-advertisement`,
            headers: noCache,
          });
        });

      /** POST git-upload-pack — negotiation + pack (DESIGN.md §2.3). */
      const handleUploadPack = (
        request: HttpServerRequest.HttpServerRequest,
        meta: RepoMetaData,
      ) =>
        Effect.gen(function* () {
          const rawBody = new Uint8Array(yield* request.arrayBuffer);
          const body = yield* gunzipIfNeeded(
            rawBody,
            request.headers["content-encoding"],
          );
          const resultType = "application/x-git-upload-pack-result";
          const errResponse = (message: string) =>
            HttpServerResponse.uint8Array(errPkt(message), {
              contentType: resultType,
              headers: noCache,
            });

          const parsed = yield* decodePktLines(body).pipe(
            Effect.flatMap(parseUploadPackRequest),
            Effect.map(Option.some),
            Effect.catchTag("PktLineError", (e) =>
              Effect.succeed(Option.none<UploadPackRequest>()).pipe(
                Effect.tap(() => Effect.logWarning(`upload-pack: ${e.reason}`)),
              ),
            ),
            Effect.catchTag("WireProtocolError", (e) =>
              Effect.succeed(Option.none<UploadPackRequest>()).pipe(
                Effect.tap(() => Effect.logWarning(`upload-pack: ${e.reason}`)),
              ),
            ),
          );
          if (Option.isNone(parsed)) {
            return errResponse("malformed upload-pack request");
          }
          const req = parsed.value;
          const objects = storeFor(meta.repoId);
          const sideband = req.capabilities.has("side-band-64k");
          const noDone = req.capabilities.has("no-done");

          const commons = yield* objects.filterExisting(req.haves);

          // Negotiation round without done and nothing in common: answer
          // NAK and wait for the next round (or done). EXCEPT when the
          // request carries `deepen` — the shallow/unshallow section must
          // precede the NAK ("fatal: expected shallow/unshallow, got NAK"
          // otherwise), so depth-carrying rounds fall through to the
          // closure computation below.
          if (!req.done && commons.length === 0 && req.depth === undefined) {
            return HttpServerResponse.uint8Array(pktText("NAK"), {
              contentType: resultType,
              headers: noCache,
            });
          }

          // Bundle fast path (DESIGN.md §12.2): a full clone whose wants are
          // all covered by the current bundle is served as bytes straight
          // from R2 — no closure walk, no per-object reads. `bundleCovers`
          // refuses anything with haves/depth/shallow state.
          const bundle = yield* readBundle;
          if (
            req.done &&
            bundle !== undefined &&
            bundleCovers(bundle, {
              wants: req.wants,
              haves: req.haves,
              depth: req.depth,
              clientShallow: req.clientShallow,
            })
          ) {
            // The DO does NOT stream the pack: it hands the Worker a
            // *marker* naming the R2 object, and the Worker streams those
            // bytes to the client itself (DESIGN.md §11, serving plane).
            // Auth and planning still happen here — where tokens and refs
            // live — but no pack byte transits this object, which is the
            // whole point of splitting the planes.
            const found = yield* blobs
              .head(bundle.key)
              .pipe(
                Effect.mapError(
                  (error) =>
                    new StoreError({ reason: `bundle: ${error.reason}` }),
                ),
              );
            if (found !== null) {
              return HttpServerResponse.empty({
                status: 200,
                headers: {
                  ...noCache,
                  "content-type": resultType,
                  [BUNDLE_KEY_HEADER]: bundle.key,
                  [BUNDLE_HASH_HEADER]: bundle.refsHash,
                  [BUNDLE_COUNT_HEADER]: String(bundle.objectCount),
                  [BUNDLE_SIDEBAND_HEADER]: sideband ? "1" : "0",
                },
              });
            }
          }

          // A depth-limited import leaves the repo itself shallow; those
          // boundary commits must bound every walk and surface as
          // `shallow` lines so clones inherit the shallowness (fsck-clean).
          const shallowRoots = JSON.parse(
            (yield* getConfig("shallow_roots")) ?? "[]",
          ) as ReadonlyArray<string>;
          const closureResult = yield* Effect.result(
            computeClosure({ sql, objects })({
              wants: req.wants,
              haves: commons,
              depth: req.depth,
              clientShallow: req.clientShallow,
              repoShallow: shallowRoots,
            }),
          );
          if (Result.isFailure(closureResult)) {
            const error = closureResult.failure;
            return errResponse(
              error._tag === "ManifestTooLarge"
                ? `repository too large to serve in one pack (${error.count} > ${error.cap})`
                : error.reason,
            );
          }
          const closure = closureResult.success;

          // v0 clients only parse a shallow/unshallow section when THEY
          // brought shallowness into the exchange (`deepen` or `shallow`
          // lines). If this repo's own boundary truncated the walk for a
          // client that did neither, an unsolicited section would derail
          // its parser — refuse cleanly instead.
          const clientShallowAware =
            req.depth !== undefined || req.clientShallow.length > 0;
          if (closure.shallow.length > 0 && !clientShallowAware) {
            return errResponse(
              "repository has shallow history (imported with depth); clone with --depth",
            );
          }
          const head: Array<Uint8Array> = [];
          if (clientShallowAware) {
            for (const oid of closure.shallow) {
              head.push(pktText(`shallow ${oid}`));
            }
            for (const oid of closure.unshallow) {
              head.push(pktText(`unshallow ${oid}`));
            }
            head.push(flushPkt);
          }

          // Depth-carrying negotiation round with nothing in common and no
          // done yet: the response is the shallow section ALONE (lines +
          // flush) — no NAK, no pack. The stateless client buffers this
          // response, sends `done`, and expects the NEXT response to begin
          // with the shallow section again; a trailing NAK here would sit
          // in its buffer and derail that parse ("expected shallow list").
          if (!req.done && commons.length === 0) {
            return HttpServerResponse.uint8Array(concatBytes(head), {
              contentType: resultType,
              headers: noCache,
            });
          }
          const lastCommon = commons[commons.length - 1];
          if (req.done) {
            head.push(
              lastCommon === undefined
                ? pktText("NAK")
                : pktText(`ACK ${lastCommon}`),
            );
          } else {
            // !done implies commons.length > 0 (the NAK-only branch above).
            const ready = lastCommon ?? ZERO_OID;
            for (const common of commons) {
              head.push(pktText(`ACK ${common} common`));
            }
            head.push(pktText(`ACK ${ready} ready`));
            if (!noDone) {
              // Client will re-POST with done; no pack this round.
              return HttpServerResponse.uint8Array(concatBytes(head), {
                contentType: resultType,
                headers: noCache,
              });
            }
            head.push(pktText(`ACK ${ready}`));
          }

          // The pack goes out through the native pump (Sideband.ts
          // `pumpPackBody`, DESIGN §22.3): the emitter's batched chunks are
          // large, so the Effect→ReadableStream bridge is a handful of
          // pulls, and framing/flush happen at platform speed.
          const source = yield* packStream(closure.entries, objects).pipe(
            Stream.toReadableStreamEffect(),
          );
          const prefix = sideband
            ? concatBytes([
                concatBytes(head),
                progressMessage(
                  `Enumerating objects: ${closure.entries.length}, done.`,
                ),
              ])
            : concatBytes(head);
          return HttpServerResponse.raw(
            pumpPackBody({ prefix, source, sideband }),
            { contentType: resultType, headers: noCache },
          );
        });

      // ── alarm jobs ───────────────────────────────────────────────────────
      /** Nulls a committed push's `staged_push` column and drops its row. */
      const flipPush = (pushId: string) =>
        Effect.gen(function* () {
          yield* sql.run(
            `UPDATE objects SET staged_push = NULL WHERE staged_push = ?`,
            pushId,
          );
          yield* sql.run(
            `DELETE FROM pushes WHERE push_id = ? AND state = 'committed'`,
            pushId,
          );
        });

      const runGcJob = Effect.gen(function* () {
        // Committed pushes whose deferred flip never ran (DESIGN §22.14).
        yield* sql.run(
          `UPDATE objects SET staged_push = NULL WHERE staged_push IN
             (SELECT push_id FROM pushes WHERE state = 'committed')`,
        );
        yield* sql.run(`DELETE FROM pushes WHERE state = 'committed'`);
        const cutoff = Date.now() - STAGING_TTL_MS;
        yield* sql.run(
          `DELETE FROM objects WHERE staged_push IN
             (SELECT push_id FROM pushes WHERE state = 'staging' AND started_at < ?)`,
          cutoff,
        );
        yield* sql.run(
          `DELETE FROM pushes WHERE state = 'staging' AND started_at < ?`,
          cutoff,
        );
        yield* sql.run(`DELETE FROM jobs WHERE kind = 'gc'`);
      });

      /**
       * Compaction (DESIGN.md §12.1): moves loose object bytes out of DO
       * SQLite into an immutable R2 pack, bounded per run and re-armed
       * while more remain.
       */
      const runCompactAlarm = Effect.gen(function* () {
        const meta = yield* requireMeta;
        // Grace-delete packs a PREVIOUS merge unreferenced: only after
        // a minute, so any read planned before that row flip has long
        // finished its ranged reads (DESIGN.md §21).
        const pendingRaw = yield* getConfig("packs_pending_delete");
        const pending =
          pendingRaw === undefined || pendingRaw === ""
            ? undefined
            : (JSON.parse(pendingRaw) as { keys: Array<string>; at: number });
        if (pending !== undefined && Date.now() - pending.at > 60_000) {
          yield* blobs
            .delete(pending.keys)
            .pipe(Effect.catch(() => Effect.void));
          yield* setConfig("packs_pending_delete", "");
        }
        const outcome = yield* runCompactJob({
          repoId: meta.repoId,
          sql,
          blobs,
        });
        // Restore the geometric invariant over the repo's packs, so pack
        // count — and with it read fan-out — stays O(log bytes).
        const merge = yield* runGeometricMergeJob({
          repoId: meta.repoId,
          sql,
          blobs,
        });
        if (merge.pendingDelete.length > 0) {
          const carried =
            pending !== undefined && !(Date.now() - pending.at > 60_000)
              ? pending.keys
              : [];
          yield* setConfig(
            "packs_pending_delete",
            JSON.stringify({
              keys: [...carried, ...merge.pendingDelete],
              at: Date.now(),
            }),
          );
        }
        if (outcome.more || merge.more) {
          yield* armAlarmAt(Date.now() + 1_000);
          return;
        }
        yield* sql.run(`DELETE FROM jobs WHERE kind = 'compact'`);
      });

      /** The repo's current clone bundle, if one has been cut. */
      /**
       * Pushes the denormalised display fields to the Registry so listing
       * repos never has to wake this DO (DESIGN.md §15 bottleneck 7).
       * Best-effort: the DO remains the source of truth, and a failed
       * refresh only makes a listing momentarily stale.
       */
      const syncSummary = Effect.fn(function* (meta: RepoMetaData) {
        yield* registry
          .updateSummary(meta.repoId, {
            defaultBranch: meta.defaultBranch,
            readOnly: meta.readOnly,
            status: meta.status,
            public: meta.public,
          })
          .pipe(Effect.ignore);
      });

      /** Re-reads metadata and refreshes the Registry summary. */
      const refreshSummary: Effect.Effect<void, never, RuntimeContext> =
        readMeta.pipe(
          Effect.flatMap((meta) =>
            meta === undefined ? Effect.void : syncSummary(meta),
          ),
          Effect.ignore,
        );

      const readBundle: Effect.Effect<BundleInfo | undefined, StoreError> =
        getConfig("bundle").pipe(
          Effect.map((value) =>
            value === undefined ? undefined : (JSON.parse(value) as BundleInfo),
          ),
        );

      /**
       * Republishes the repo's head snapshot (DESIGN.md §21): a tiny
       * JSON object in the BlobStore from which the Worker serves
       * anonymous public reads — the upload-pack advertisement and
       * bundle-covered clones — without waking this DO. Called after
       * every commit that changes what an anonymous reader can see.
       *
       * Best-effort by design: it runs AFTER the SQLite commit (which
       * stays authoritative), so a failed write only leaves a stale
       * snapshot that the next mutation — or the post-push bundle
       * alarm, seconds later — repairs.
       */
      const writeHeadSnapshot: Effect.Effect<void, never, RuntimeContext> =
        Effect.gen(function* () {
          const meta = yield* requireMeta;
          const refs = yield* listAllRefs(meta.repoId);
          const bundle = yield* readBundle;
          const snapshot: HeadSnapshot = {
            v: 1,
            repoId: meta.repoId,
            owner: meta.owner,
            name: meta.name,
            public: meta.public,
            readOnly: meta.readOnly,
            defaultBranch: meta.defaultBranch,
            refs,
            bundle,
          };
          yield* blobs.put(
            headKey(meta.repoId),
            utf8Encode(encodeHeadSnapshot(snapshot)),
          );
        }).pipe(
          Effect.catch((error) =>
            Effect.logWarning(`head snapshot write failed: ${String(error)}`),
          ),
          Effect.asVoid,
        );

      /**
       * Cuts a clone bundle for the current refs (DESIGN.md §12.2) so future
       * clones are served as bytes from R2 instead of a fresh closure walk.
       */
      const runBundleAlarm = Effect.gen(function* () {
        const meta = yield* requireMeta;
        const objects = storeFor(meta.repoId);
        const refRows = yield* sql.all<RefRow>(
          `SELECT name, oid FROM refs ORDER BY name`,
        );
        const shallowRoots = JSON.parse(
          (yield* getConfig("shallow_roots")) ?? "[]",
        ) as ReadonlyArray<string>;
        const closure = yield* computeClosure({ sql, objects })({
          wants: refRows.map((ref) => ref.oid),
          haves: [],
          clientShallow: [],
          repoShallow: shallowRoots,
        }).pipe(
          Effect.catchTag("ManifestTooLarge", (error) =>
            Effect.fail(new StoreError({ reason: `bundle: ${error._tag}` })),
          ),
        );
        const info = yield* runBundleJob({
          repoId: meta.repoId,
          refs: refRows.map((ref) => ({ name: ref.name, oid: ref.oid })),
          entries: closure.entries,
          packStream: (entries) => packStream(entries, objects),
          blobs,
        });
        if (info !== undefined) {
          yield* setConfig("bundle", JSON.stringify(info));
          // The snapshot now names a bundle covering the current refs —
          // full anonymous clones go DO-less from here (DESIGN.md §21).
          yield* writeHeadSnapshot;
        }
        yield* sql.run(`DELETE FROM jobs WHERE kind = 'bundle'`);
      });

      const runImportAlarm = (job: JobRow) =>
        Effect.gen(function* () {
          const meta = yield* requireMeta;
          const detail = JSON.parse(job.detail ?? "{}") as {
            readonly source: ImportSource;
            readonly attempts?: number;
          };
          const attempts = detail.attempts ?? 0;
          const outcome = yield* Effect.result(
            runImport({ source: detail.source }).pipe(
              Effect.provide(FetchHttpClient.layer),
            ),
          );
          if (Result.isFailure(outcome)) {
            if (attempts + 1 >= 3) {
              yield* sql.run(
                `UPDATE jobs SET state = 'failed', detail = ?, updated_at = ? WHERE kind = 'import'`,
                JSON.stringify({ ...detail, error: outcome.failure.reason }),
                Date.now(),
              );
              // Give the empty repo back rather than wedging in 'importing'.
              yield* setConfig("status", "ready");
              yield* refreshSummary;
              yield* refreshSummary;
              return;
            }
            yield* sql.run(
              `UPDATE jobs SET detail = ?, updated_at = ? WHERE kind = 'import'`,
              JSON.stringify({ ...detail, attempts: attempts + 1 }),
              Date.now(),
            );
            yield* armAlarmAt(Date.now() + 15_000);
            return;
          }
          const result = outcome.success;
          const objects = storeFor(meta.repoId);
          const pushId = yield* ulid();
          // Imports use the same staging lifecycle as pushes: finalize
          // requires an active row, and GC needs it to reap abandoned data.
          yield* sql.run(
            `INSERT INTO pushes (push_id, started_at, state) VALUES (?, ?, 'staging')`,
            pushId,
            Date.now(),
          );
          yield* upsertJob("gc", null);
          yield* armAlarmAt(Date.now() + STAGING_TTL_MS);
          let graph: Array<{
            oid: string;
            tree: string;
            gen: number;
            commitTime: number;
            parents: ReadonlyArray<string>;
          }> = [];
          if (result.pack !== undefined) {
            const ingest = yield* ingestPack(result.pack, {
              store: objects,
              pushId,
              allowMissingParents: true,
            }).pipe(
              Effect.mapError(
                (error) =>
                  new StoreError({
                    reason:
                      error._tag === "PackIngestError"
                        ? `import ingest: ${error.reason}`
                        : error.reason,
                  }),
              ),
            );
            // Connectivity: hard edges only — shallow imports may lack
            // parent commits (they become walk boundaries).
            const missing = yield* objects.missingObjects(
              [...ingest.referenced],
              pushId,
            );
            if (missing.length > 0) {
              return yield* new StoreError({
                reason: `import produced ${missing.length} dangling objects`,
              });
            }
            graph = yield* computeGraphRows(ingest.commits);
            // A depth-limited import leaves parents un-ingested: record the
            // boundary commits so upload-pack serves this repo as shallow
            // (walk bound + `shallow` lines — see handleUploadPack).
            const parentOids = Array.from(
              new Set(ingest.commits.flatMap((commit) => commit.parents)),
            );
            const missingParents = new Set(
              yield* objects.missingObjects(parentOids, pushId),
            );
            if (missingParents.size > 0) {
              const shallowRoots = ingest.commits
                .filter((commit) =>
                  commit.parents.some((parent) => missingParents.has(parent)),
                )
                .map((commit) => commit.oid);
              yield* setConfig("shallow_roots", JSON.stringify(shallowRoots));
            }
          }
          const commands: Array<RefCommand> = result.refs.map((ref) => ({
            oldOid: ZERO_OID,
            newOid: ref.oid,
            ref: ref.name,
          }));
          const results = yield* finalizeRefTxn({
            commands,
            atomic: false,
            unconditional: true,
            pushId,
            graph,
          });
          const rejected = results.find((ref) => !ref.ok);
          if (rejected !== undefined) {
            return yield* new StoreError({
              reason: `import ref ${rejected.ref}: ${rejected.reason}`,
            });
          }
          yield* flipPush(pushId);
          if (result.defaultBranch !== null) {
            yield* setConfig("default_branch", result.defaultBranch);
          }
          yield* setConfig("status", "ready");
          yield* refreshSummary;
          yield* writeHeadSnapshot;
          yield* sql.run(`DELETE FROM jobs WHERE kind = 'import'`);
        });

      const runForkAlarm = (job: JobRow) =>
        Effect.gen(function* () {
          const detail = JSON.parse(job.detail ?? "{}") as {
            readonly parentRepoId: string;
            readonly attempts?: number;
          };
          const parentStub = selfNamespace.getByName(
            detail.parentRepoId,
          ) as unknown as RepoStub;
          const applied = yield* Effect.result(
            runForkJob({
              sql,
              snapshot: parentStub.snapshotRows(),
            }),
          );
          if (Result.isFailure(applied)) {
            const attempts = (detail.attempts ?? 0) + 1;
            if (attempts >= 3) {
              yield* sql.run(
                `UPDATE jobs SET state = 'failed', detail = ?, updated_at = ? WHERE kind = 'fork'`,
                JSON.stringify({ ...detail, error: applied.failure.reason }),
                Date.now(),
              );
              yield* setConfig("status", "ready");
              yield* refreshSummary;
              yield* refreshSummary;
              return;
            }
            yield* sql.run(
              `UPDATE jobs SET detail = ?, updated_at = ? WHERE kind = 'fork'`,
              JSON.stringify({ ...detail, attempts }),
              Date.now(),
            );
            yield* armAlarmAt(Date.now() + 15_000);
            return;
          }
          yield* setConfig("status", "ready");
          yield* refreshSummary;
          yield* writeHeadSnapshot;
          yield* sql.run(`DELETE FROM jobs WHERE kind = 'fork'`);
        });

      /** Returns true when storage was wiped (stop touching SQLite). */
      const runPurgeAlarm = Effect.gen(function* () {
        const meta = yield* readMeta;
        if (meta === undefined) return true;
        const registryStub = registry;
        const outcome = yield* runPurgeJob({
          repoId: meta.repoId,
          blobs,
          // RuntimeContext is genuinely satisfied here (we run inside the
          // DO); discharge the coloring so the purge job's deps stay R=never.
          forkCount: registryStub.bumpForkCount(meta.repoId, 0).pipe(
            Effect.mapError(
              (error) => new StoreError({ reason: String(error) }),
            ),
            Effect.provide(RuntimeContext.phantom),
          ),
          deleteAllStorage: state.storage.deleteAll().pipe(
            Effect.mapError(
              (error) => new StoreError({ reason: String(error) }),
            ),
            Effect.provide(RuntimeContext.phantom),
          ),
          removeRegistryRow: registryStub.removeRow(meta.repoId).pipe(
            Effect.mapError(
              (error) => new StoreError({ reason: String(error) }),
            ),
            Effect.provide(RuntimeContext.phantom),
          ),
        });
        if (outcome._tag === "continue") {
          yield* armAlarmAt(Date.now() + (outcome.forkPinned ? 60_000 : 5_000));
          return false;
        }
        yield* state.storage.deleteAlarm();
        return true;
      });

      // ── the shape ────────────────────────────────────────────────────────
      const shape: GitRepoShape = {
        initRepo: (input) =>
          bootstrap(input, "ready").pipe(Effect.tap(() => writeHeadSnapshot)),

        startImport: Effect.fn(function* (input: StartImportInput) {
          const result = yield* bootstrap(input, "importing");
          yield* upsertJob("import", JSON.stringify({ source: input.source }));
          yield* armAlarmAt(Date.now());
          return result;
        }),

        startFork: Effect.fn(function* (input: StartForkInput) {
          const result = yield* bootstrap(input, "forking");
          yield* upsertJob(
            "fork",
            JSON.stringify({ parentRepoId: input.parentRepoId }),
          );
          yield* armAlarmAt(Date.now());
          return result;
        }),

        startCompact: Effect.fn(function* () {
          yield* requireMeta;
          yield* upsertJob("compact", null);
          yield* armAlarmAt(Date.now());
        }),

        startPurge: Effect.fn(function* () {
          const meta = yield* requireMeta;
          yield* setConfig("status", "deleting");
          // Kill the DO-less fast path NOW — the prefix drain gets the
          // rest, but anonymous reads must stop serving immediately.
          yield* blobs
            .delete(headKey(meta.repoId))
            .pipe(Effect.catch(() => Effect.void));
          yield* refreshSummary;
          yield* upsertJob("purge", null);
          yield* armAlarmAt(Date.now());
        }),

        getRepoMeta: Effect.fn(function* () {
          const meta = yield* requireMetaStats;
          return meta;
        }),

        readMeta: Effect.fn(function* () {
          return yield* requireMetaStats;
        }),

        updateRepoMeta: Effect.fn(function* (patch: RepoMetaPatch) {
          const meta = yield* requireMeta;
          if (patch.defaultBranch !== undefined) {
            const ref = yield* sql.first<RefRow>(
              `SELECT name, oid FROM refs WHERE name = ?`,
              `refs/heads/${patch.defaultBranch}`,
            );
            if (ref === undefined) {
              return yield* new RefNotFound({
                ref: `refs/heads/${patch.defaultBranch}`,
              });
            }
            yield* setConfig("default_branch", patch.defaultBranch);
          }
          if (patch.description !== undefined) {
            if (patch.description === null) {
              yield* sql.run(`DELETE FROM config WHERE key = 'description'`);
            } else {
              yield* setConfig("description", patch.description);
            }
          }
          if (patch.readOnly !== undefined) {
            yield* setConfig("read_only", patch.readOnly ? "1" : "0");
          }
          if (patch.public !== undefined) {
            yield* setConfig("public", patch.public ? "1" : "0");
          }
          const updated = yield* readMetaStats;
          const result = updated ?? meta;
          // Keep the Registry's denormalised copy in step (listing reads it).
          yield* syncSummary(result);
          yield* writeHeadSnapshot;
          return result;
        }),

        listRefs: Effect.fn(function* (prefix?: string | undefined) {
          const meta = yield* requireMeta;
          const refs = yield* listAllRefs(meta.repoId, prefix);
          const headRef = `refs/heads/${meta.defaultBranch}`;
          const headExists = yield* sql.first<RefRow>(
            `SELECT name, oid FROM refs WHERE name = ?`,
            headRef,
          );
          return {
            head: headExists === undefined ? null : headRef,
            refs,
          } satisfies RefsPage;
        }),

        getRef: Effect.fn(function* (name: string) {
          const meta = yield* requireMeta;
          const row = yield* sql.first<RefRow>(
            `SELECT name, oid FROM refs WHERE name = ?`,
            name,
          );
          if (row === undefined) {
            return yield* new RefNotFound({ ref: name });
          }
          const peeled = name.startsWith("refs/tags/")
            ? yield* peelOid(meta.repoId, row.oid)
            : undefined;
          return peeled === undefined
            ? { name: row.name, oid: row.oid }
            : ({ name: row.name, oid: row.oid, peeled } satisfies RefData);
        }),

        updateRef: Effect.fn(function* (input: UpdateRefInput) {
          const meta = yield* requireMeta;
          if (meta.readOnly) {
            return yield* new ReadOnlyRepo();
          }
          const objects = storeFor(meta.repoId);
          const exists = yield* objects.has(input.newOid);
          if (!exists) {
            return yield* new ObjectNotFound({ oid: input.newOid });
          }
          yield* sql.transactionSync<void, RefConflict>((raw, rollback) => {
            const rows = raw
              .exec<RefRow>(
                `SELECT name, oid FROM refs WHERE name = ?`,
                input.name,
              )
              .toArray();
            const current = rows.length > 0 ? rows[0]!.oid : null;
            if (input.expectedOid !== undefined) {
              const expected = input.expectedOid; // string | null
              if (current !== expected) {
                rollback(
                  new RefConflict({
                    ref: input.name,
                    currentOid: current === null ? null : asOid(current),
                  }),
                );
              }
            }
            raw.exec(
              `INSERT INTO refs (name, oid) VALUES (?, ?)
               ON CONFLICT (name) DO UPDATE SET oid = excluded.oid`,
              input.name,
              input.newOid,
            );
          });
          yield* writeHeadSnapshot;
          return { name: input.name, oid: input.newOid } satisfies RefData;
        }),

        removeRef: Effect.fn(function* (input: RemoveRefInput) {
          const meta = yield* requireMeta;
          if (meta.readOnly) {
            return yield* new ReadOnlyRepo();
          }
          yield* sql.transactionSync<void, RefConflict | RefNotFound>(
            (raw, rollback) => {
              const rows = raw
                .exec<RefRow>(
                  `SELECT name, oid FROM refs WHERE name = ?`,
                  input.name,
                )
                .toArray();
              if (rows.length === 0) {
                rollback(new RefNotFound({ ref: input.name }));
              }
              const current = rows[0]!.oid;
              if (
                input.expectedOid !== undefined &&
                current !== input.expectedOid
              ) {
                rollback(
                  new RefConflict({
                    ref: input.name,
                    currentOid: asOid(current),
                  }),
                );
              }
              raw.exec(`DELETE FROM refs WHERE name = ?`, input.name);
            },
          );
          yield* writeHeadSnapshot;
        }),

        beginPush: Effect.fn(function* (input: BeginPushInput) {
          const meta = yield* requireMeta;
          if (meta.readOnly) {
            return {
              _tag: "denied",
              reason: "repository is read-only",
            } as const;
          }
          const pushId = yield* ulid();
          yield* sql.run(
            `INSERT INTO pushes (push_id, started_at, state) VALUES (?, ?, 'staging')`,
            pushId,
            Date.now(),
          );
          return { _tag: "ok", pushId } as const;
        }),

        stagePush: Effect.fn(function* (pushId: string, batch: Uint8Array) {
          const meta = yield* requireMeta;
          yield* storeFor(meta.repoId).insertStagedBatch(
            pushId,
            decodeStagedBatch(batch),
          );
        }),

        abortPush: Effect.fn(function* (
          pushId: string,
          packIds: ReadonlyArray<string> = [],
        ) {
          yield* requireMeta;
          return yield* sql.transactionSync((raw) => {
            const push = raw
              .exec<{ state: string }>(
                `SELECT state FROM pushes WHERE push_id = ?`,
                pushId,
              )
              .toArray()[0];
            if (push?.state === "committed") return false;
            raw.exec(`DELETE FROM objects WHERE staged_push = ?`, pushId);
            raw.exec(
              `DELETE FROM pushes WHERE push_id = ? AND state = 'staging'`,
              pushId,
            );
            // Another concurrent push may have adopted staged rows. Retain any
            // shared pack bytes even though this transaction has been aborted.
            for (const packId of packIds) {
              if (
                raw
                  .exec(
                    `SELECT 1 FROM objects WHERE pack_id = ? LIMIT 1`,
                    packId,
                  )
                  .toArray().length > 0
              )
                return false;
            }
            return true;
          });
        }),

        validatePush: Effect.fn(function* (input: CommitPushInput) {
          const meta = yield* requireMeta;
          const referenced = new Set([
            ...input.referenced,
            ...input.referencedParents,
          ]);
          for (const command of input.commands)
            if (command.newOid !== ZERO_OID) referenced.add(command.newOid);
          const missing = yield* storeFor(meta.repoId).missingObjects(
            Array.from(referenced),
            input.pushId,
          );
          if (missing.length > 0)
            return yield* new StoreError({
              reason: `missing objects (${missing.length})`,
            });
        }),

        readPreparedObject: Effect.fn(function* (
          pushId: string,
          oid: Oid,
          maxBytes: number,
        ) {
          const meta = yield* requireMeta;
          const push = yield* sql.first<{ state: string }>(
            `SELECT state FROM pushes WHERE push_id = ?`,
            pushId,
          );
          if (push?.state !== "staging")
            return yield* new StoreError({
              reason: "push is no longer active",
            });
          return yield* storeFor(meta.repoId).readPrepared(
            pushId,
            oid,
            maxBytes,
          );
        }),

        readPushBase: Effect.fn(function* (oid: Oid) {
          const meta = yield* requireMeta;
          return yield* ingestStoreOf(storeFor(meta.repoId)).readBase(oid);
        }),

        commitPush: Effect.fn(function* (input: CommitPushInput) {
          const meta = yield* requireMeta;
          const objects = storeFor(meta.repoId);
          const startedAt = yield* Effect.sync(() => performance.now());
          const since = (from: number) =>
            Effect.sync(() => performance.now() - from);
          const allNg = (reason: string) =>
            input.commands.map((cmd) => ({
              ref: cmd.ref,
              ok: false,
              reason,
            }));
          if (meta.readOnly)
            return { unpack: "ok", results: allNg("repository is read-only") };
          // Full connectivity check (§3.6 step 5) over the staged rows.
          const referenced = new Set<string>(input.referenced);
          for (const parent of input.referencedParents) referenced.add(parent);
          for (const cmd of input.commands) {
            if (cmd.newOid !== ZERO_OID) referenced.add(cmd.newOid);
          }
          const connectivityStarted = yield* Effect.sync(() =>
            performance.now(),
          );
          const missing = yield* objects.missingObjects(
            Array.from(referenced),
            input.pushId,
          );
          const connectivityMs = yield* since(connectivityStarted);
          if (missing.length > 0) {
            return {
              unpack: `missing objects (${missing.length})`,
              results: allNg("missing necessary objects"),
            } satisfies CommitPushResult;
          }
          const graph = yield* computeGraphRows(input.commits);
          const finalizeStarted = yield* Effect.sync(() => performance.now());
          const results = yield* finalizeRefTxn({
            commands: input.commands,
            atomic: input.atomic,
            pushId: input.pushId,
            deferFlip: true,
            graph,
          });
          const finalizeMs = yield* since(finalizeStarted);
          // The per-row flip, off the response path (DESIGN §22.14).
          yield* state.waitUntil(flipPush(input.pushId).pipe(Effect.ignore));

          yield* setConfig(
            "last_push",
            JSON.stringify({
              objects: input.stats.objects,
              bytes: input.stats.bytes,
              ingestMs: Math.round(input.stats.ingestMs),
              phases:
                input.stats.phases === undefined
                  ? undefined
                  : Object.fromEntries(
                      Object.entries(input.stats.phases).map(([k, v]) => [
                        k,
                        Math.round(v),
                      ]),
                    ),
              stageMs: Math.round(input.stats.stageMs),
              connectivityMs: Math.round(connectivityMs),
              finalizeMs: Math.round(finalizeMs),
              totalMs: Math.round(yield* since(startedAt)),
            } satisfies PushStatsData),
          ).pipe(Effect.ignore);

          // Post-commit bookkeeping off the response path: staged-row GC
          // and, once enough loose bytes have accumulated, compaction into
          // an R2 pack (DESIGN.md §12.1).
          yield* state.waitUntil(
            upsertJob("gc", null).pipe(
              Effect.flatMap(() => armAlarmAt(Date.now() + STAGING_TTL_MS)),
              Effect.flatMap(() => shouldCompact(sql)),
              Effect.flatMap((due) =>
                due
                  ? upsertJob("compact", null).pipe(
                      Effect.flatMap(() => armAlarmAt(Date.now() + 1_000)),
                    )
                  : Effect.void,
              ),
              // Re-cut the clone bundle for the new ref snapshot. Debounced
              // by the alarm itself: rapid-fire pushes coalesce into one
              // run because the job row is upserted, not queued.
              Effect.flatMap(() => upsertJob("bundle", null)),
              Effect.flatMap(() => armAlarmAt(Date.now() + 2_000)),
              Effect.ignore,
            ),
          );
          return { unpack: "ok", results } satisfies CommitPushResult;
        }),

        readObject: Effect.fn(function* (input: ReadObjectInput) {
          const meta = yield* requireMeta;
          const objects = storeFor(meta.repoId);
          const objectMeta = yield* objects.getMeta(input.oid);
          if (objectMeta === undefined) {
            return yield* new ObjectNotFound({ oid: input.oid });
          }
          const actual = objectTypeName(objectMeta.type);
          if (input.expect !== undefined && actual !== input.expect) {
            return yield* new WrongObjectType({
              oid: input.oid,
              expected: input.expect,
              actual,
            });
          }
          const content = yield* objects.readContent(input.oid);
          return {
            oid: input.oid,
            type: actual,
            size: objectMeta.size,
            content,
          } satisfies ObjectData;
        }),

        readCommitLog: Effect.fn(function* (input: CommitLogInput) {
          const meta = yield* requireMeta;
          const objects = storeFor(meta.repoId);
          const limit = Math.max(1, Math.min(input.limit ?? 20, 100));

          // Resolve the starting commit.
          const start = yield* resolveRevision(meta.defaultBranch, input.ref);

          // Commit-time-ordered walk (v1: recomputed from the start each
          // page; the cursor is the last emitted oid).
          const frontier: Array<{ oid: string; time: number }> = [];
          const visited = new Set<string>();
          const items: Array<CommitData> = [];
          let skipping = input.cursor !== undefined;
          let hasMore = false;

          const pushFrontier = Effect.fn(function* (oid: string) {
            if (visited.has(oid)) return;
            visited.add(oid);
            const row = yield* sql.first<{ commit_time: number }>(
              `SELECT commit_time FROM commits WHERE oid = ?`,
              oid,
            );
            if (row !== undefined) {
              frontier.push({ oid, time: row.commit_time });
            }
          });
          // The start may be a tag — peel to a commit.
          const startMeta = yield* objects.getMeta(start);
          if (startMeta === undefined) {
            return yield* new RefNotFound({ ref: input.ref ?? "HEAD" });
          }
          const startCommit =
            startMeta.type === ObjectType.tag
              ? yield* peelOid(meta.repoId, start).pipe(
                  Effect.map((peeled) => peeled ?? start),
                )
              : start;
          yield* pushFrontier(startCommit);

          while (frontier.length > 0) {
            // pop max commit_time
            let best = 0;
            for (let i = 1; i < frontier.length; i++) {
              if (frontier[i]!.time > frontier[best]!.time) best = i;
            }
            const [next] = frontier.splice(best, 1);
            const oid = next!.oid;
            const parents = yield* sql.all<{ parent: string; ord: number }>(
              `SELECT parent, ord FROM commit_parents WHERE oid = ? ORDER BY ord`,
              oid,
            );
            for (const parent of parents) {
              yield* pushFrontier(parent.parent);
            }
            if (skipping) {
              if (oid === input.cursor) skipping = false;
              continue;
            }
            if (items.length >= limit) {
              hasMore = true;
              break;
            }
            const content = yield* objects.readContent(oid);
            const parsed = yield* parseCommit(content).pipe(
              Effect.mapError(
                (error) => new StoreError({ reason: error.reason }),
              ),
            );
            items.push({
              oid,
              tree: parsed.tree,
              parents: parsed.parents,
              author: {
                name: parsed.author.name,
                email: parsed.author.email,
                date: parsed.author.when,
                tz: parsed.author.tz,
              },
              committer: {
                name: parsed.committer.name,
                email: parsed.committer.email,
                date: parsed.committer.when,
                tz: parsed.committer.tz,
              },
              message: parsed.message,
            });
          }

          return {
            items,
            nextCursor: hasMore ? items[items.length - 1]!.oid : null,
            hasMore,
          } satisfies CommitLogPage;
        }),

        readCommitDiff: Effect.fn(function* (input: { readonly oid: string }) {
          const meta = yield* requireMeta;
          const objects = storeFor(meta.repoId);

          const readCommitOrFail = Effect.fn(function* (oid: string) {
            const objectMeta = yield* objects.getMeta(oid);
            if (objectMeta === undefined) {
              return yield* new ObjectNotFound({ oid });
            }
            if (objectMeta.type !== ObjectType.commit) {
              return yield* new WrongObjectType({
                oid,
                expected: "commit",
                actual: objectTypeName(objectMeta.type),
              });
            }
            const content = yield* objects.readContent(oid);
            return yield* parseCommit(content).pipe(
              Effect.mapError(
                (error) => new StoreError({ reason: error.reason }),
              ),
            );
          });

          const commit = yield* readCommitOrFail(input.oid);
          // First-parent diff (the GitHub default for merge commits).
          const parent = commit.parents[0] ?? null;
          const parentTree =
            parent === null
              ? undefined
              : (yield* readCommitOrFail(parent)).tree;

          const result = yield* diffTrees(objects, parentTree, commit.tree);
          return {
            oid: input.oid,
            parent,
            files: result.files,
            truncated: result.truncated,
          } satisfies CommitDiffData;
        }),

        compareCommits: Effect.fn(function* (input: CompareInput) {
          const meta = yield* requireMeta;
          const objects = storeFor(meta.repoId);

          const baseOid = yield* resolveToCommit(
            meta.repoId,
            meta.defaultBranch,
            input.base,
          );
          const headOid = yield* resolveToCommit(
            meta.repoId,
            meta.defaultBranch,
            input.head,
          );

          // The classic merge-base paint walk over the commit-graph tables,
          // ordered by the pre-computed generation number (`gen`, maintained
          // at ingest): a common ancestor's gen is strictly less than any
          // node on a path to it, so processing gen-descending guarantees
          // the first both-flagged pop is a best common ancestor. Nodes
          // carrying both flags propagate both but are counted as neither.
          const BASE = 1;
          const HEAD = 2;
          const BOTH = 3;
          const flags = new Map<string, number>();
          flags.set(baseOid, BASE);
          flags.set(headOid, (flags.get(headOid) ?? 0) | HEAD);
          const heap: Array<WalkHeapNode> = [];
          const timeOf = new Map<string, number>();

          const rowOf = (oid: string) =>
            sql.first<{ gen: number; commit_time: number }>(
              `SELECT gen, commit_time FROM commits WHERE oid = ?`,
              oid,
            );

          // seed (base === head short-circuits: mergeBase = both, 0/0)
          for (const oid of new Set([baseOid, headOid])) {
            const row = yield* rowOf(oid);
            if (row === undefined) {
              return yield* new ObjectNotFound({ oid });
            }
            heapPush(heap, { oid, gen: row.gen, time: row.commit_time });
            timeOf.set(oid, row.commit_time);
          }

          let mergeBase: string | undefined;
          let aheadBy = 0;
          let behindBy = 0;
          let pops = 0;
          const headSide: Array<string> = [];

          while (heap.length > 0 && pops < MAX_COMPARE_WALK) {
            // stop when nothing in the heap can still change the counts
            if (
              mergeBase !== undefined &&
              heap.every((n) => (flags.get(n.oid)! & BOTH) === BOTH)
            ) {
              break;
            }
            const node = heapPop(heap);
            pops++;
            const f = flags.get(node.oid)!;
            if ((f & BOTH) === BOTH) {
              if (mergeBase === undefined) mergeBase = node.oid;
            } else if (f === HEAD) {
              aheadBy++;
              headSide.push(node.oid);
            } else {
              behindBy++;
            }
            const parents = yield* sql.all<{ parent: string }>(
              `SELECT parent FROM commit_parents WHERE oid = ? ORDER BY ord`,
              node.oid,
            );
            for (const { parent } of parents) {
              const prev = flags.get(parent) ?? 0;
              const next = prev | f;
              if (next === prev) continue;
              flags.set(parent, next);
              if (prev === 0) {
                const row = yield* rowOf(parent);
                if (row === undefined) continue; // shallow boundary
                heapPush(heap, {
                  oid: parent,
                  gen: row.gen,
                  time: row.commit_time,
                });
                timeOf.set(parent, row.commit_time);
              }
              // already-heaped nodes just get richer flags; no decrease-key
              // needed (flags only grow; both-flagged pops count as neither)
            }
          }
          if (mergeBase === undefined) {
            return yield* new NoMergeBase({
              base: asOid(baseOid),
              head: asOid(headOid),
            });
          }

          // head-side commits, committer-time descending, capped.
          headSide.sort((a, b) => (timeOf.get(b) ?? 0) - (timeOf.get(a) ?? 0));
          const commitOids = headSide.slice(0, MAX_COMPARE_COMMITS);
          const commits: Array<CommitData> = [];
          for (const oid of commitOids) {
            const content = yield* objects.readContent(oid);
            const parsed = yield* parseCommit(content).pipe(
              Effect.mapError(
                (error) => new StoreError({ reason: error.reason }),
              ),
            );
            commits.push({
              oid,
              tree: parsed.tree,
              parents: parsed.parents,
              author: {
                name: parsed.author.name,
                email: parsed.author.email,
                date: parsed.author.when,
                tz: parsed.author.tz,
              },
              committer: {
                name: parsed.committer.name,
                email: parsed.committer.email,
                date: parsed.committer.when,
                tz: parsed.committer.tz,
              },
              message: parsed.message,
            });
          }

          // three-dot file diff: mergeBase tree vs head tree
          const treeOf = Effect.fn(function* (oid: string) {
            const row = yield* sql.first<{ tree: string }>(
              `SELECT tree FROM commits WHERE oid = ?`,
              oid,
            );
            if (row === undefined) {
              return yield* new StoreError({
                reason: `commit ${oid} missing from the commit graph`,
              });
            }
            return row.tree;
          });
          const mergeBaseTree = yield* treeOf(mergeBase);
          const headTree = yield* treeOf(headOid);
          const filesResult = yield* diffTrees(
            objects,
            mergeBaseTree,
            headTree,
          );

          return {
            base: baseOid,
            head: headOid,
            mergeBase,
            aheadBy,
            behindBy,
            commits,
            commitsTruncated:
              headSide.length > MAX_COMPARE_COMMITS || pops >= MAX_COMPARE_WALK,
            files: filesResult.files,
            filesTruncated: filesResult.truncated,
          } satisfies CompareData;
        }),

        readFileAtPath: Effect.fn(function* (input: ReadFileInput) {
          const meta = yield* requireMeta;
          const objects = storeFor(meta.repoId);

          const startOid = yield* resolveRevision(
            meta.defaultBranch,
            input.ref,
          );

          // Resolve start → commit → root tree (peel tags on the way).
          const rootTree = yield* Effect.gen(function* () {
            let current = startOid;
            for (let hops = 0; hops < 16; hops++) {
              const objectMeta = yield* objects.getMeta(current);
              if (objectMeta === undefined) {
                return yield* new ObjectNotFound({ oid: current });
              }
              if (objectMeta.type === ObjectType.tree) return current;
              const content = yield* objects.readContent(current);
              if (objectMeta.type === ObjectType.commit) {
                const parsed = yield* parseCommit(content).pipe(
                  Effect.mapError(
                    (error) => new StoreError({ reason: error.reason }),
                  ),
                );
                return parsed.tree;
              }
              if (objectMeta.type === ObjectType.tag) {
                const parsed = yield* parseTag(content).pipe(
                  Effect.mapError(
                    (error) => new StoreError({ reason: error.reason }),
                  ),
                );
                current = parsed.object;
                continue;
              }
              return yield* new ObjectNotFound({ oid: current });
            }
            return yield* new ObjectNotFound({ oid: current });
          });

          const segments = input.path.split("/").filter(Boolean);
          if (segments.length === 0) {
            return yield* new ObjectNotFound({ oid: rootTree });
          }
          let treeOid = rootTree;
          for (let i = 0; i < segments.length; i++) {
            const content = yield* objects.readContent(treeOid);
            const entries = yield* parseTree(content).pipe(
              Effect.mapError(
                (error) => new StoreError({ reason: error.reason }),
              ),
            );
            const entry = entries.find((e) => e.name === segments[i]);
            if (entry === undefined) {
              return yield* new ObjectNotFound({ oid: `${input.path}` });
            }
            const kind = treeEntryKind(entry.mode);
            if (i === segments.length - 1) {
              if (kind !== "blob") {
                return yield* new ObjectNotFound({ oid: input.path });
              }
              const blobMeta = yield* objects.getMeta(entry.oid);
              if (blobMeta === undefined) {
                return yield* new ObjectNotFound({ oid: entry.oid });
              }
              const blob = yield* objects.readContent(entry.oid);
              return {
                oid: entry.oid,
                mode: entry.mode,
                size: blobMeta.size,
                content: blob,
              } satisfies FileData;
            }
            if (kind !== "tree") {
              return yield* new ObjectNotFound({ oid: input.path });
            }
            treeOid = entry.oid;
          }
          // unreachable — the loop returns or fails
          return yield* new ObjectNotFound({ oid: input.path });
        }),

        createPull: Effect.fn(function* (input: CreatePullInput) {
          yield* requireMeta;
          const baseRef = yield* normalizeBranchRef(input.base);
          const headRef = yield* normalizeBranchRef(input.head);
          if (baseRef === headRef) {
            return yield* new ValidationError({
              message: "base and head must be different branches",
            });
          }
          for (const ref of [baseRef, headRef]) {
            const row = yield* sql.first<RefRow>(
              `SELECT name, oid FROM refs WHERE name = ?`,
              ref,
            );
            if (row === undefined) {
              return yield* new BranchMissing({ ref });
            }
          }
          const duplicate = yield* sql.first<{ number: number }>(
            `SELECT number FROM pulls WHERE state = 'open' AND base_ref = ? AND head_ref = ?`,
            baseRef,
            headRef,
          );
          if (duplicate !== undefined) {
            return yield* new PullExists({ number: duplicate.number });
          }
          const now = Date.now();
          // Allocate the number and insert the row in ONE transaction —
          // the DO's input/output gates make the counter race-free.
          const number = yield* sql.transactionSync((raw) => {
            const seq = raw
              .exec<{ value: string }>(
                `SELECT value FROM config WHERE key = 'pull_seq'`,
              )
              .toArray()[0];
            const next = (seq === undefined ? 0 : Number(seq.value)) + 1;
            raw.exec(
              `INSERT INTO config (key, value) VALUES ('pull_seq', ?)
               ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
              String(next),
            );
            raw.exec(
              `INSERT INTO pulls (number, title, body, base_ref, head_ref, state, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, 'open', ?, ?)`,
              next,
              input.title,
              input.body ?? null,
              baseRef,
              headRef,
              now,
              now,
            );
            return next;
          });
          return {
            number,
            title: input.title,
            body: input.body ?? null,
            baseRef,
            headRef,
            state: "open",
            createdAt: now,
            updatedAt: now,
            mergedAt: null,
            mergeCommit: null,
          } satisfies PullData;
        }),

        listPulls: Effect.fn(function* (input: ListPullsInput) {
          yield* requireMeta;
          const state = input.state ?? "open";
          const limit = Math.max(1, Math.min(input.limit ?? 20, 100));
          const cursor =
            input.cursor === undefined ? undefined : Number(input.cursor);
          const where: Array<string> = [];
          const bindings: Array<string | number> = [];
          if (state !== "all") {
            where.push("state = ?");
            bindings.push(state);
          }
          if (cursor !== undefined && Number.isFinite(cursor)) {
            where.push("number < ?");
            bindings.push(cursor);
          }
          const rows = yield* sql.all<PullRow>(
            `SELECT * FROM pulls
             ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
             ORDER BY number DESC LIMIT ?`,
            ...bindings,
            limit + 1,
          );
          const items = rows.slice(0, limit).map(rowToPull);
          const hasMore = rows.length > limit;
          return {
            items,
            nextCursor: hasMore
              ? String(items[items.length - 1]!.number)
              : null,
            hasMore,
          } satisfies PullsPage;
        }),

        getPull: Effect.fn(function* (number: number) {
          const meta = yield* requireMeta;
          const row = yield* loadPull(number);
          const pull = rowToPull(row);
          const empty = {
            baseOid: null,
            headOid: null,
            mergeBase: null,
            aheadBy: null,
            behindBy: null,
            mergeable: null,
            mergeableReason: null,
          } as const;
          // A merged PR's record is `mergeCommit` — live fields stay null.
          if (pull.state === "merged") {
            return { ...pull, ...empty } satisfies PullDetailData;
          }
          const baseRow = yield* sql.first<RefRow>(
            `SELECT name, oid FROM refs WHERE name = ?`,
            row.base_ref,
          );
          const headRow = yield* sql.first<RefRow>(
            `SELECT name, oid FROM refs WHERE name = ?`,
            row.head_ref,
          );
          if (baseRow === undefined || headRow === undefined) {
            // A branch is gone: everything downstream is uncomputable.
            return {
              ...pull,
              ...empty,
              baseOid: baseRow?.oid ?? null,
              headOid: headRow?.oid ?? null,
            } satisfies PullDetailData;
          }
          const baseTip = baseRow.oid;
          const headTip = headRow.oid;
          const cmp = yield* paintWalk(baseTip, headTip, MAX_PULL_WALK);
          if (cmp.saturated) {
            return {
              ...pull,
              ...empty,
              baseOid: baseTip,
              headOid: headTip,
              mergeableReason: "unknown",
            } satisfies PullDetailData;
          }
          const live = {
            ...pull,
            baseOid: baseTip,
            headOid: headTip,
            mergeBase: cmp.mergeBase ?? null,
            aheadBy: cmp.aheadBy,
            behindBy: cmp.behindBy,
          };
          if (cmp.mergeBase === undefined) {
            // Disjoint histories: our trivial-merge rules can never merge.
            return {
              ...live,
              mergeable: false,
              mergeableReason: "conflict",
            } satisfies PullDetailData;
          }
          if (cmp.mergeBase === headTip) {
            return {
              ...live,
              mergeable: false,
              mergeableReason: "up-to-date",
            } satisfies PullDetailData;
          }
          if (cmp.mergeBase === baseTip) {
            return {
              ...live,
              mergeable: true,
              mergeableReason: "ff",
            } satisfies PullDetailData;
          }
          // Trivial-merge dry run: diff intersection only, no tree building.
          const objects = storeFor(meta.repoId);
          const mbTree = yield* treeOfCommit(cmp.mergeBase);
          const baseChanges = yield* diffTrees(
            objects,
            mbTree,
            yield* treeOfCommit(baseTip),
          );
          const headChanges = yield* diffTrees(
            objects,
            mbTree,
            yield* treeOfCommit(headTip),
          );
          if (baseChanges.truncated || headChanges.truncated) {
            // Can't see every change — conservatively not mergeable.
            return {
              ...live,
              mergeable: false,
              mergeableReason: "conflict",
            } satisfies PullDetailData;
          }
          const conflicts = conflictingPaths(
            baseChanges.files,
            headChanges.files,
          );
          return {
            ...live,
            mergeable: conflicts.length === 0,
            mergeableReason:
              conflicts.length === 0 ? "merge-commit" : "conflict",
          } satisfies PullDetailData;
        }),

        updatePull: Effect.fn(function* (input: UpdatePullInput) {
          yield* requireMeta;
          const row = yield* loadPull(input.number);
          const current = pullStateOf(row.state);
          if (input.state !== undefined && current === "merged") {
            return yield* new PullStateConflict({
              number: input.number,
              state: "merged",
            });
          }
          const title = input.title ?? row.title;
          const body = input.body === undefined ? row.body : input.body;
          const state = input.state ?? current;
          yield* sql.run(
            `UPDATE pulls SET title = ?, body = ?, state = ?, updated_at = ? WHERE number = ?`,
            title,
            body,
            state,
            Date.now(),
            input.number,
          );
          return rowToPull(yield* loadPull(input.number));
        }),

        mergePull: Effect.fn(function* (input: MergePullInput) {
          const meta = yield* requireMeta;
          if (meta.readOnly) {
            return yield* new ReadOnlyRepo();
          }
          const row = yield* loadPull(input.number);
          const state = pullStateOf(row.state);
          if (state !== "open") {
            return yield* new PullStateConflict({
              number: input.number,
              state,
            });
          }
          // Both branches must exist — the ref CAS below must NEVER
          // (re)create a deleted base branch.
          const baseRow = yield* sql.first<RefRow>(
            `SELECT name, oid FROM refs WHERE name = ?`,
            row.base_ref,
          );
          if (baseRow === undefined) {
            return yield* new BranchMissing({ ref: row.base_ref });
          }
          const headRow = yield* sql.first<RefRow>(
            `SELECT name, oid FROM refs WHERE name = ?`,
            row.head_ref,
          );
          if (headRow === undefined) {
            return yield* new BranchMissing({ ref: row.head_ref });
          }
          const baseTip = baseRow.oid;
          if (
            input.expectedBaseOid !== undefined &&
            input.expectedBaseOid !== baseTip
          ) {
            return yield* new RefConflict({
              ref: row.base_ref,
              currentOid: asOid(baseTip),
            });
          }
          const headTip = headRow.oid;
          if (
            input.expectedHeadOid !== undefined &&
            input.expectedHeadOid !== headTip
          ) {
            return yield* new RefConflict({
              ref: row.head_ref,
              currentOid: asOid(headTip),
            });
          }
          const cmp = yield* paintWalk(baseTip, headTip, MAX_PULL_MERGE_WALK);
          if (cmp.mergeBase === headTip) {
            return yield* new NothingToMerge({ number: input.number });
          }
          const now = Date.now();

          // ── fast-forward: base is an ancestor of head ──────────────────
          if (cmp.mergeBase === baseTip) {
            // No new objects, no graph rows (all present from the push) —
            // one transaction re-checks the CAS, flips the ref, and stamps
            // the pulls row atomically.
            const pull = yield* sql.transactionSync<PullData, RefConflict>(
              (raw, rollback) => {
                const rows = raw
                  .exec<RefRow>(
                    `SELECT name, oid FROM refs WHERE name = ?`,
                    row.base_ref,
                  )
                  .toArray();
                const currentOid = rows.length > 0 ? rows[0]!.oid : null;
                if (currentOid !== baseTip) {
                  rollback(
                    new RefConflict({
                      ref: row.base_ref,
                      currentOid:
                        currentOid === null ? null : asOid(currentOid),
                    }),
                  );
                }
                raw.exec(
                  `INSERT INTO refs (name, oid) VALUES (?, ?)
                   ON CONFLICT (name) DO UPDATE SET oid = excluded.oid`,
                  row.base_ref,
                  headTip,
                );
                raw.exec(
                  `UPDATE pulls SET state = 'merged', merged_at = ?, merge_commit = ?, updated_at = ? WHERE number = ?`,
                  now,
                  headTip,
                  now,
                  input.number,
                );
                const updated = raw
                  .exec<PullRow>(
                    `SELECT * FROM pulls WHERE number = ?`,
                    input.number,
                  )
                  .toArray()[0]!;
                return rowToPull(updated);
              },
            );
            // The base moved: the head snapshot (which serves clones
            // without waking this object) must say so.
            yield* writeHeadSnapshot;
            return {
              method: "ff",
              oid: headTip,
              pull,
            } satisfies MergePullResult;
          }

          // ── trivial three-way merge commit ─────────────────────────────
          if (cmp.mergeBase === undefined) {
            // Unrelated histories (or a saturated walk): conservative
            // conflict — the server never guesses.
            return yield* new MergeConflict({
              number: input.number,
              paths: [],
            });
          }
          const objects = storeFor(meta.repoId);
          const mbTree = yield* treeOfCommit(cmp.mergeBase);
          const baseTree = yield* treeOfCommit(baseTip);
          const baseChanges = yield* diffTrees(objects, mbTree, baseTree);
          const headChanges = yield* diffTrees(
            objects,
            mbTree,
            yield* treeOfCommit(headTip),
          );
          if (baseChanges.truncated || headChanges.truncated) {
            // A truncated diff hides changes — conflict detection would be
            // unsound, so refuse conservatively.
            return yield* new MergeConflict({
              number: input.number,
              paths: [],
            });
          }
          const conflicts = conflictingPaths(
            baseChanges.files,
            headChanges.files,
          );
          if (conflicts.length > 0) {
            return yield* new MergeConflict({
              number: input.number,
              paths: conflicts.slice(0, MAX_CONFLICT_PATHS),
            });
          }

          // Build the merged tree: head's mergeBase→head changes applied
          // onto the CURRENT base tree (disjoint by the check above).
          const applied = yield* applyTreeChanges(
            objects,
            baseTree,
            headChanges.files,
          );
          const shortHead = row.head_ref.startsWith("refs/heads/")
            ? row.head_ref.slice("refs/heads/".length)
            : row.head_ref;
          const message =
            input.message ??
            `Merge pull request #${input.number} from ${shortHead}\n`;
          const when = Math.floor(now / 1000);
          const identity = {
            name: "git-service",
            email: "git-service@localhost",
            when,
            tz: "+0000",
          };
          const commitContent = yield* encodeCommit({
            tree: applied.root,
            parents: [baseTip, headTip],
            author: identity,
            committer: identity,
            message,
          }).pipe(Effect.mapError((e) => new StoreError({ reason: e.reason })));
          const mergeOid = yield* hashObject(ObjectType.commit, commitContent);

          // Stage under a synthetic push id WITH a pushes staging row first,
          // so the staging-GC alarm reaps the objects if we crash (or the
          // CAS below loses) — the exact crash-safety story of a push.
          const pushId = `pr-${input.number}-${yield* ulid()}`;
          yield* sql.run(
            `INSERT INTO pushes (push_id, started_at, state) VALUES (?, ?, 'staging')`,
            pushId,
            now,
          );
          const zlibToStore = (error: Zlib.ZlibError): StoreError =>
            new StoreError({ reason: error.reason });
          const staged: Array<StagedObject> = [];
          for (const tree of applied.newTrees) {
            staged.push({
              oid: tree.oid,
              type: ObjectType.tree,
              size: tree.content.length,
              zdata: yield* Zlib.deflate(tree.content).pipe(
                Effect.mapError(zlibToStore),
              ),
            });
          }
          staged.push({
            oid: mergeOid,
            type: ObjectType.commit,
            size: commitContent.length,
            zdata: yield* Zlib.deflate(commitContent).pipe(
              Effect.mapError(zlibToStore),
            ),
          });
          yield* objects.insertStagedBatch(pushId, staged);
          // Crash safety: arm the staging-GC alarm (like the push path) so
          // a lost CAS below — or a crash before finalize — cannot leak the
          // staged objects; a committed push's row is ignored by the GC.
          yield* upsertJob("gc", null);
          yield* armAlarmAt(Date.now() + STAGING_TTL_MS);

          const graph = yield* computeGraphRows([
            {
              oid: mergeOid,
              tree: applied.root,
              parents: [baseTip, headTip],
              commitTime: when,
            },
          ]);
          const results = yield* finalizeRefTxn({
            commands: [
              { oldOid: baseTip, newOid: mergeOid, ref: row.base_ref },
            ],
            atomic: true,
            pushId,
            graph,
            // Atomic with the ref flip + staged-object promotion.
            onCommitted: (raw) => {
              raw.exec(
                `UPDATE pulls SET state = 'merged', merged_at = ?, merge_commit = ?, updated_at = ? WHERE number = ?`,
                now,
                mergeOid,
                now,
                input.number,
              );
            },
          });
          const outcome = results[0];
          if (outcome === undefined || !outcome.ok) {
            // Base moved between the pre-check and the transaction. The
            // staged objects stay parked under `pushId` for the GC alarm.
            const current = yield* sql.first<RefRow>(
              `SELECT name, oid FROM refs WHERE name = ?`,
              row.base_ref,
            );
            return yield* new RefConflict({
              ref: row.base_ref,
              currentOid: current === undefined ? null : asOid(current.oid),
            });
          }
          // Post-merge compaction check deliberately skipped: the merge
          // adds at most a handful of small trees + one commit (the push
          // path's thresholds cover accumulation).
          yield* writeHeadSnapshot;
          return {
            method: "merge-commit",
            oid: mergeOid,
            pull: rowToPull(yield* loadPull(input.number)),
          } satisfies MergePullResult;
        }),

        snapshotRows: () => snapshotStream(sql),

        fetch: Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const path = parseWirePath(request.url);
          if (path === undefined) {
            return HttpServerResponse.text("not found", { status: 404 });
          }
          const meta = yield* readMeta;
          if (meta === undefined) {
            return HttpServerResponse.text("repository not found", {
              status: 404,
            });
          }
          // Stale-cache fail-safe (DESIGN.md §2.1): this DO only answers
          // for its own owner/name.
          if (path.owner !== meta.owner || path.repo !== meta.name) {
            return HttpServerResponse.text("repository not found", {
              status: 404,
            });
          }
          if (meta.status !== "ready") {
            return wire503;
          }
          if (path.endpoint === "info/refs" && request.method === "GET") {
            return yield* handleInfoRefs(request, path.service, meta);
          }
          if (
            path.endpoint === "git-upload-pack" &&
            request.method === "POST"
          ) {
            return yield* handleUploadPack(request, meta);
          }
          return HttpServerResponse.text("not found", { status: 404 });
        }).pipe(
          Effect.catchTag("StoreError", (error) =>
            Effect.as(
              Effect.logError("git wire: storage failure", error),
              HttpServerResponse.text("internal error", { status: 500 }),
            ),
          ),
          Effect.catchTag("PackIngestError", (error) =>
            Effect.succeed(
              HttpServerResponse.uint8Array(errPkt(error.reason), {
                status: 200,
                headers: noCache,
              }),
            ),
          ),
        ),

        alarm: () =>
          Effect.gen(function* () {
            const jobs = yield* sql.all<JobRow>(
              `SELECT * FROM jobs WHERE state = 'running'`,
            );
            // `purge` runs FIRST and every job is individually isolated: a
            // job that keeps crashing must never starve the others. (It
            // did: a fork job dying on every alarm blocked the purge job
            // behind it forever, wedging the repo in `status: deleting`
            // and reserving its name.)
            const order = (kind: string) =>
              kind === "purge" ? 0 : kind === "gc" ? 2 : 1;
            const ordered = [...jobs].sort(
              (a, b) => order(a.kind) - order(b.kind),
            );
            for (const job of ordered) {
              const isolated = Effect.gen(function* () {
                switch (job.kind) {
                  case "purge": {
                    const wiped = yield* runPurgeAlarm;
                    return wiped; // storage is gone — stop the whole alarm
                  }
                  case "import":
                    yield* runImportAlarm(job);
                    return false;
                  case "fork":
                    yield* runForkAlarm(job);
                    return false;
                  case "gc":
                    yield* runGcJob;
                    return false;
                  case "compact":
                    yield* runCompactAlarm;
                    return false;
                  case "bundle":
                    yield* runBundleAlarm;
                    return false;
                  default:
                    yield* sql.run(`DELETE FROM jobs WHERE kind = ?`, job.kind);
                    return false;
                }
              }).pipe(
                Effect.catchCause((cause) =>
                  Effect.as(
                    Effect.logError(
                      `repo alarm job '${job.kind}' failed`,
                      cause,
                    ),
                    false,
                  ),
                ),
              );
              if (yield* isolated) return;
            }
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.gen(function* () {
                yield* Effect.logError("repo alarm failed", cause);
                // Best-effort retry — never let the alarm defect.
                yield* armAlarmAt(Date.now() + 30_000).pipe(Effect.ignore);
              }),
            ),
            Effect.asVoid,
          ),
      };

      return shape;
    });
  }),
);

export default GitRepoLive;
