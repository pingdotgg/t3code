/**
 * Shared schemas of the git-service REST contract (DESIGN.md §5):
 * primitives, the tagged-error taxonomy, and the domain shapes. The
 * per-group endpoint declarations live in the sibling modules (`Repos.ts`,
 * `Refs.ts`, `Objects.ts`, `Pulls.ts`); the assembled `GitApi` lives in
 * `../Api.ts`.
 *
 * The groups carry no middleware and no auth errors of their own: the
 * `HttpApi` you mount them in decides who may call them, and application handlers
 * decide which refs may move.
 */
import * as Schema from "effect/Schema";
// Pulls in the `httpApiStatus` annotation augmentation used by the error
// classes below.
import "effect/unstable/httpapi/HttpApiSchema";

// ─────────────────────────────────────────────────────────────────────────────
// Primitives
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A 40-hex SHA-1 object id, branded so oids never mix with plain strings.
 * Widening to SHA-256 later is mechanical because every consumer goes
 * through this schema (DESIGN.md §1 "Hashing").
 */
export const Oid = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/)).pipe(
  Schema.brand("Oid"),
);

/** The decoded (branded) type of {@link Oid}. */
export type Oid = typeof Oid.Type;

/**
 * A repository name: 1–100 chars, alphanumeric with `._-` separators,
 * must start and end alphanumeric. Case-insensitive match, stored as given.
 */
export const RepoName = Schema.String.check(
  Schema.isPattern(/^[a-z0-9](?:[a-z0-9._-]{0,98}[a-z0-9])?$/i),
);

/**
 * An owner (namespace) name. Same grammar as {@link RepoName}. The literal
 * owner `api` is reserved (rejected by the Registry at creation) so the
 * `/api/v1` prefix can never collide with a repo URL.
 */
export const OwnerName = RepoName;

/**
 * A full ref name (`refs/heads/main`, `refs/tags/v1.0`). Rejects the
 * whitespace / `~^:?*[\` characters git itself forbids. HEAD is virtual
 * (symref to the default branch) and is never a valid `RefName` here.
 */
export const RefName = Schema.String.check(
  Schema.isPattern(/^refs\/[^\s~^:?*\[\\]+$/),
);

/**
 * Lifecycle status of a repo. Async operations (import/fork/delete) flip
 * this field; clients poll `GET /repos/:owner/:repo` until `ready` (or 404
 * once a `deleting` repo's purge completes). There is no jobs API.
 */
export const RepoStatus = Schema.Literals([
  "ready",
  "importing",
  "forking",
  "deleting",
]);

/** The decoded type of {@link RepoStatus}. */
export type RepoStatus = typeof RepoStatus.Type;

// ─────────────────────────────────────────────────────────────────────────────
// Error taxonomy (tagged, status-annotated)
// ─────────────────────────────────────────────────────────────────────────────

/** 403 — the repo is flagged `readOnly`; writes are rejected. */
export class ReadOnlyRepo extends Schema.TaggedError<ReadOnlyRepo>()(
  "ReadOnlyRepo",
  {},
  { httpApiStatus: 403 },
) {}

/** 403 — application policy refused a proposed ref update. */
export class PushDenied extends Schema.TaggedError<PushDenied>()(
  "PushDenied",
  { ref: Schema.String, reason: Schema.String },
  { httpApiStatus: 403 },
) {}

/** 404 — no repo at `owner/repo` (or it finished deleting). */
export class RepoNotFound extends Schema.TaggedError<RepoNotFound>()(
  "RepoNotFound",
  { owner: Schema.String, repo: Schema.String },
  { httpApiStatus: 404 },
) {}

/** 409 — a repo already exists at `owner/repo`. */
export class RepoAlreadyExists extends Schema.TaggedError<RepoAlreadyExists>()(
  "RepoAlreadyExists",
  { owner: Schema.String, repo: Schema.String },
  { httpApiStatus: 409 },
) {}

/**
 * 409 — the repo exists but is not `ready` (importing / forking /
 * deleting); retry after polling `GET /repos/:owner/:repo`.
 */
export class RepoNotReady extends Schema.TaggedError<RepoNotReady>()(
  "RepoNotReady",
  { status: RepoStatus },
  { httpApiStatus: 409 },
) {}

/** 404 — the named ref does not exist. */
export class RefNotFound extends Schema.TaggedError<RefNotFound>()(
  "RefNotFound",
  { ref: Schema.String },
  { httpApiStatus: 404 },
) {}

/**
 * 409 — compare-and-swap failure on a ref write: `expectedOid` did not
 * match the ref's current value (`currentOid`, `null` when the ref does
 * not exist).
 */
export class RefConflict extends Schema.TaggedError<RefConflict>()(
  "RefConflict",
  { ref: Schema.String, currentOid: Schema.NullOr(Oid) },
  { httpApiStatus: 409 },
) {}

/** 404 — no object with the given oid in this repo. */
export class ObjectNotFound extends Schema.TaggedError<ObjectNotFound>()(
  "ObjectNotFound",
  { oid: Schema.String },
  { httpApiStatus: 404 },
) {}

/** 422 — the object exists but has a different type than the endpoint expects. */
export class WrongObjectType extends Schema.TaggedError<WrongObjectType>()(
  "WrongObjectType",
  { oid: Schema.String, expected: Schema.String, actual: Schema.String },
  { httpApiStatus: 422 },
) {}

/**
 * 422 — the blob is too large for the base64 JSON endpoint (> 1 MiB);
 * use the raw streaming route `GET .../blobs/:oid/raw` instead.
 */
export class ObjectTooLarge extends Schema.TaggedError<ObjectTooLarge>()(
  "ObjectTooLarge",
  { oid: Schema.String, size: Schema.Number },
  { httpApiStatus: 422 },
) {}

/**
 * 422 — the two commits share no common ancestor within the walk bound
 * (disjoint histories, or divergence beyond the server's 10k-commit cap;
 * shallow imports can also surface this across the shallow boundary).
 */
export class NoMergeBase extends Schema.TaggedError<NoMergeBase>()(
  "NoMergeBase",
  { base: Oid, head: Oid },
  { httpApiStatus: 422 },
) {}

/** 502 — the async import job failed against the source remote. */
export class ImportFailed extends Schema.TaggedError<ImportFailed>()(
  "ImportFailed",
  { reason: Schema.String },
  { httpApiStatus: 502 },
) {}

/** 400 — semantically invalid request (e.g. reserved owner name). */
export class ValidationError extends Schema.TaggedError<ValidationError>()(
  "ValidationError",
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}

/** 404 — no pull request with this number. */
export class PullNotFound extends Schema.TaggedError<PullNotFound>()(
  "PullNotFound",
  { number: Schema.Number },
  { httpApiStatus: 404 },
) {}

/** 422 — the PR's base or head branch does not exist (deleted after open). */
export class BranchMissing extends Schema.TaggedError<BranchMissing>()(
  "BranchMissing",
  { ref: Schema.String },
  { httpApiStatus: 422 },
) {}

/** 409 — an open PR for this base/head pair already exists. */
export class PullExists extends Schema.TaggedError<PullExists>()(
  "PullExists",
  { number: Schema.Number },
  { httpApiStatus: 409 },
) {}

/**
 * 409 — the operation is invalid in the PR's current state (e.g. merge a
 * merged PR, reopen a merged PR).
 */
export class PullStateConflict extends Schema.TaggedError<PullStateConflict>()(
  "PullStateConflict",
  {
    number: Schema.Number,
    state: Schema.Literals(["open", "closed", "merged"]),
  },
  { httpApiStatus: 409 },
) {}

/** 422 — head is already reachable from base; there is nothing to merge. */
export class NothingToMerge extends Schema.TaggedError<NothingToMerge>()(
  "NothingToMerge",
  { number: Schema.Number },
  { httpApiStatus: 422 },
) {}

/**
 * 409 — the three-way merge is not trivial: these paths changed on both
 * sides relative to the merge base.
 */
export class MergeConflict extends Schema.TaggedError<MergeConflict>()(
  "MergeConflict",
  {
    number: Schema.Number,
    /** Conflicting paths, capped at 20 (the full set may be larger). */
    paths: Schema.Array(Schema.String),
  },
  { httpApiStatus: 409 },
) {}

// ─────────────────────────────────────────────────────────────────────────────
// Auth middleware
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Domain shapes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A repository resource as returned by the management plane.
 */
/**
 * Where a repo's objects currently live (DESIGN.md §12.1). `loose` rows
 * hold their bytes in DO SQLite; `packed` objects have been compacted into
 * immutable R2 packs; `r2` objects are oversize singletons in R2.
 */
export class ObjectStats extends Schema.Class<ObjectStats>("ObjectStats")({
  /** Objects whose bytes are still in DO SQLite rows. */
  loose: Schema.Number,
  /** Commits, trees and tags kept in SQLite rows (never packed). */
  resident: Schema.Number,
  /** Objects compacted into R2 packs. */
  packed: Schema.Number,
  /** Oversize objects stored as standalone R2 keys. */
  r2: Schema.Number,
  /** Total compressed bytes across all locations. */
  bytes: Schema.Number,
}) {}

/**
 * Server-side timing of the most recent push (DESIGN.md §19 phase 0).
 *
 * Wall-clock `git push` time includes client-side packing and the upload,
 * so it bounds server cost rather than measuring it. These are measured
 * inside the Durable Object, around the work itself.
 */
export class PushStats extends Schema.Class<PushStats>("PushStats")({
  /** Objects in the pushed pack. */
  objects: Schema.Number,
  /** Pack bytes received. */
  bytes: Schema.Number,
  /** Parsing + staging the pack (inflate, sha1, SQL). */
  ingestMs: Schema.Number,
  /**
   * The SQL staging portion of `ingestMs`. `ingestMs - stageMs` is CPU:
   * inflate, sha1, delta resolution, commit/tree parsing. The split decides
   * whether sharding storage or hoisting parsing is the real win
   * (DESIGN.md §19).
   */
  stageMs: Schema.Number,
  /** The connectivity check. */
  connectivityMs: Schema.Number,
  /** The ref CAS transaction. */
  finalizeMs: Schema.Number,
  /** Everything the DO did for this push. */
  totalMs: Schema.Number,
  /**
   * Ingest split by phase (ms): inflate, hash, delta, deflate, copy, sink.
   * Meaningful as CPU only where the clock runs during synchronous work
   * (local workerd); production workerd freezes `performance.now()` between
   * awaits, so there only phases that yield to the event loop accumulate —
   * which is itself diagnostic (an async inflate path shows up, a sync one
   * reads 0).
   */
  phases: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
}) {}

export class Repo extends Schema.Class<Repo>("Repo")({
  /** Owner (namespace) segment of the repo's URL. */
  owner: OwnerName,
  /** Repo name segment of the repo's URL. */
  name: RepoName,
  /**
   * The stable ULID identity of the repo. Renames never move data because
   * the Repo DO id derives from `repoId`, not `owner/name`.
   */
  repoId: Schema.String,
  /** Short branch name (e.g. `main`) that HEAD symrefs to. */
  defaultBranch: Schema.String,
  /** Optional human description. */
  description: Schema.NullOr(Schema.String),
  /** When `true`, receive-pack and REST ref writes are rejected. */
  readOnly: Schema.Boolean,
  /**
   * Public repos are readable (REST reads and `git clone`/`fetch`)
   * without any token; writes always require one.
   */
  public: Schema.Boolean,
  /** Parent `repoId` when this repo is a fork, else `null`. */
  forkOf: Schema.NullOr(Schema.String),
  /** Lifecycle status; poll this for async fork/import/delete progress. */
  status: RepoStatus,
  /** Creation time, epoch milliseconds. */
  createdAt: Schema.Number,
  /** Object storage breakdown (DESIGN.md §12.1). */
  objects: ObjectStats,
  /** Server-side timing of the last push, if any (DESIGN.md §19). */
  lastPush: Schema.NullOr(PushStats),
}) {}

/**
 * A ref (branch or tag). `peeled` carries the target commit for annotated
 * tags (the advertisement's `^{}` line).
 */
export class Ref extends Schema.Class<Ref>("Ref")({
  /** Full ref name, e.g. `refs/heads/main`. */
  name: RefName,
  /** The object the ref points at. */
  oid: Oid,
  /** For annotated tags: the peeled (commit) oid. */
  peeled: Schema.optional(Oid),
}) {}

/** An author/committer/tagger signature line. */
const Signature = Schema.Struct({
  name: Schema.String,
  email: Schema.String,
  /** Unix timestamp (seconds). */
  date: Schema.Number,
  /** Timezone offset as written, e.g. `+0200`. */
  tz: Schema.String,
});

/** Parsed commit metadata for the REST read surface. */
export class CommitInfo extends Schema.Class<CommitInfo>("CommitInfo")({
  oid: Oid,
  /** Root tree of the commit. */
  tree: Oid,
  /** Parent commit oids in order. */
  parents: Schema.Array(Oid),
  author: Signature,
  committer: Signature,
  /** Full commit message (verbatim, including trailing newline). */
  message: Schema.String,
}) {}

/** A single tree entry. `commit` type = gitlink (submodule). */
export class TreeEntry extends Schema.Class<TreeEntry>("TreeEntry")({
  /** Octal mode string as stored, e.g. `100644`, `40000`, `120000`. */
  mode: Schema.String,
  /** Entry name (single path segment). */
  name: Schema.String,
  oid: Oid,
  /** Entry kind derived from mode. */
  type: Schema.Literals(["blob", "tree", "commit"]),
}) {}

/**
 * File-level change status. v1 has no rename detection (see the DESIGN note
 * on the `diff` endpoint in `Objects.ts`); a v1.1 exact-oid pass would add
 * `"renamed"` + an `oldPath`.
 */
export const FileStatus = Schema.Literals(["added", "removed", "modified"]);

/** The decoded type of {@link FileStatus}. */
export type FileStatus = typeof FileStatus.Type;

/**
 * One changed file in a commit diff or comparison. Content is NOT included —
 * clients fetch old/new blobs by oid (`blobs/:oid`, `blobs/:oid/raw`) and
 * diff locally. `oldSize`/`newSize` let the client gate binary/oversize
 * files without a round trip. Gitlinks (mode 160000) appear as entries whose
 * oids are commit oids; clients render "Subproject commit ..." and must not
 * fetch them as blobs.
 */
export class DiffEntry extends Schema.Class<DiffEntry>("DiffEntry")({
  /** Full slash-separated path from the repo root. */
  path: Schema.String,
  status: FileStatus,
  /** Blob oid on the old side (absent for `added`). */
  oldOid: Schema.optional(Oid),
  /** Blob oid on the new side (absent for `removed`). */
  newOid: Schema.optional(Oid),
  /** Octal mode on the old side, e.g. `100644` (absent for `added`). */
  oldMode: Schema.optional(Schema.String),
  /** Octal mode on the new side (absent for `removed`). */
  newMode: Schema.optional(Schema.String),
  /** Uncompressed byte size of the old blob (absent for `added`/gitlinks). */
  oldSize: Schema.optional(Schema.Number),
  /** Uncompressed byte size of the new blob (absent for `removed`/gitlinks). */
  newSize: Schema.optional(Schema.Number),
}) {}

/** The changed-file list of one commit vs its first parent. */
export class CommitDiff extends Schema.Class<CommitDiff>("CommitDiff")({
  oid: Oid,
  /** The first parent the diff was computed against; `null` for a root
   * commit (diffed against the empty tree — every file is `added`). */
  parent: Schema.NullOr(Oid),
  files: Schema.Array(DiffEntry),
  /** `true` when the file list was cut at the server cap (1000 files). */
  truncated: Schema.Boolean,
}) {}

/** GitHub-style three-dot comparison of two commits. */
export class Comparison extends Schema.Class<Comparison>("Comparison")({
  /** Resolved base commit oid (tags peeled). */
  base: Oid,
  /** Resolved head commit oid (tags peeled). */
  head: Oid,
  /** Best common ancestor (first both-reachable commit by generation). */
  mergeBase: Oid,
  /** Commits reachable from head but not base (`git rev-list --count base..head`). */
  aheadBy: Schema.Number,
  /** Commits reachable from base but not head. */
  behindBy: Schema.Number,
  /** head-side commits, committer-time descending, capped at 250. */
  commits: Schema.Array(CommitInfo),
  commitsTruncated: Schema.Boolean,
  /** File diff of mergeBase..head (three-dot, like GitHub compare/PR). */
  files: Schema.Array(DiffEntry),
  filesTruncated: Schema.Boolean,
}) {}

/** Lifecycle state of a pull request. `merged` is terminal. */
export const PullState = Schema.Literals(["open", "closed", "merged"]);

/** The decoded type of {@link PullState}. */
export type PullState = typeof PullState.Type;

/**
 * A pull request. PRs track **live** branches by ref name — the row stores
 * intent + lifecycle, never a diff snapshot. Diff and mergeability are
 * recomputed from current ref tips on every read (see {@link PullDetail}).
 */
export class Pull extends Schema.Class<Pull>("Pull")({
  /** Per-repo monotonic PR number (1-based, never reused). */
  number: Schema.Int,
  title: Schema.String,
  body: Schema.NullOr(Schema.String),
  /** Full base ref name, e.g. `refs/heads/main`. */
  baseRef: RefName,
  /** Full head ref name, e.g. `refs/heads/feature`. */
  headRef: RefName,
  state: PullState,
  /** Creation time, epoch milliseconds. */
  createdAt: Schema.Number,
  /** Last update (title/body/state) time, epoch milliseconds. */
  updatedAt: Schema.Number,
  /** Merge time (epoch milliseconds); `null` unless `state` is `merged`. */
  mergedAt: Schema.NullOr(Schema.Number),
  /** FF: the head tip; the merge commit otherwise. Set iff state=merged. */
  mergeCommit: Schema.NullOr(Oid),
}) {}

/**
 * PR detail = the row + live computed compare fields. Live fields are
 * `null` when uncomputable: a missing base/head branch, a saturated
 * ancestor walk, or a merged PR (its record is `mergeCommit`).
 */
export class PullDetail extends Pull.extend<PullDetail>("PullDetail")({
  /** Current tip of `baseRef`; `null` if the branch is gone. */
  baseOid: Schema.NullOr(Oid),
  /** Current tip of `headRef`; `null` if the branch is gone. */
  headOid: Schema.NullOr(Oid),
  mergeBase: Schema.NullOr(Oid),
  /** Commits on head not on base (`null` when the walk saturates). */
  aheadBy: Schema.NullOr(Schema.Int),
  /** Commits on base not on head. */
  behindBy: Schema.NullOr(Schema.Int),
  /**
   * `true` = FF-able or trivially merge-able; `false` = conflicting paths
   * or up-to-date; `null` = uncomputable.
   */
  mergeable: Schema.NullOr(Schema.Boolean),
  /** Why: `"ff" | "merge-commit" | "conflict" | "up-to-date" | "unknown"`. */
  mergeableReason: Schema.NullOr(Schema.String),
}) {}

/** Response of a successful PR merge. */
export class MergeResult extends Schema.Class<MergeResult>("MergeResult")({
  /** How the merge landed. */
  method: Schema.Literals(["ff", "merge-commit"]),
  /** The oid the base ref now points at. */
  oid: Oid,
  /** The PR row after the merge (`state: "merged"`). */
  pull: Pull,
}) {}

/**
 * Response of repo create/fork/import: the repo plus a ready-to-use HTTPS
 * remote URL and a bootstrap `write` token, killing the create-then-mint
 * round trip.
 */
export class RepoCreated extends Schema.Class<RepoCreated>("RepoCreated")({
  repo: Repo,
  /** HTTPS clone URL for the new repo. */
  remote: Schema.String,
}) {}

/**
 * Cursor-paginated wrapper used by list endpoints.
 *
 * @example
 * ```typescript
 * const page = Paginated(Repo); // { items: Repo[], nextCursor, hasMore }
 * ```
 */
export const Paginated = <A extends Schema.Top>(items: A) =>
  Schema.Struct({
    items: Schema.Array(items),
    nextCursor: Schema.NullOr(Schema.String),
    hasMore: Schema.Boolean,
  });
// ─────────────────────────────────────────────────────────────────────────────
// Shared path-parameter structs
// ─────────────────────────────────────────────────────────────────────────────

/** `(owner, repo)` path segments shared by repo-scoped endpoints. */
export const RepoPath = Schema.Struct({ owner: OwnerName, repo: RepoName });

/** `(owner, repo, oid)` path segments for object read endpoints. */
export const RepoOidPath = Schema.Struct({
  owner: OwnerName,
  repo: RepoName,
  oid: Oid,
});
