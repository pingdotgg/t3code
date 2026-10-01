/**
 * The `pulls` group: pull-request lifecycle + merge (DESIGN.md §5).
 *
 * PRs are same-repo branch PRs (no cross-fork), tracking **live** branches
 * by ref name: diff and mergeability are computed on read from current ref
 * tips. Merging fast-forwards when possible; otherwise it creates a merge
 * commit iff the three-way tree merge is trivial (no path touched on both
 * sides relative to the merge base) — a conflicting PR is a typed 409, the
 * server never writes conflict markers.
 */
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as Schema from "effect/Schema";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import {
  BranchMissing,
  MergeConflict,
  MergeResult,
  NothingToMerge,
  Oid,
  OwnerName,
  Paginated,
  Pull,
  PullDetail,
  PullExists,
  PullNotFound,
  PullStateConflict,
  ReadOnlyRepo,
  RefConflict,
  RepoName,
  RepoNotFound,
  RepoPath,
  ValidationError,
  PushDenied,
} from "./Schema.ts";

/** `(owner, repo, number)` path segments for single-PR endpoints. */
export const PullPath = Schema.Struct({
  owner: OwnerName,
  repo: RepoName,
  /** The PR number (path segment; decoded from its string form). */
  number: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
});

/**
 * Opens a PR. `base`/`head` accept short (`main`) or full
 * (`refs/heads/main`) branch names — only branches are legal (no tags).
 */
export const CreatePull = HttpApiEndpoint.post(
  "create",
  "/repos/:owner/:repo/pulls",
  {
    params: RepoPath,
    payload: Schema.Struct({
      title: Schema.String.check(Schema.isMinLength(1)),
      body: Schema.optional(Schema.String),
      /** Target branch, short or full name. */
      base: Schema.String,
      /** Source branch, short or full name. Must differ from `base`. */
      head: Schema.String,
    }),
    success: Pull,
    error: [RepoNotFound, BranchMissing, PullExists, ValidationError],
  },
);

/** Lists PRs, newest first. `state` defaults to `open`. Anonymous on public repos. */
export const ListPulls = HttpApiEndpoint.get(
  "list",
  "/repos/:owner/:repo/pulls",
  {
    params: RepoPath,
    query: Schema.Struct({
      /** Filter by lifecycle state. @default open */
      state: Schema.optional(
        Schema.Literals(["open", "closed", "merged", "all"]),
      ),
      cursor: Schema.optional(Schema.String),
      limit: Schema.optional(
        Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
      ),
    }),
    success: Paginated(Pull),
    error: [RepoNotFound],
  },
);

/** Reads one PR with live compare fields (aheadBy/behindBy/mergeable). */
export const GetPull = HttpApiEndpoint.get(
  "get",
  "/repos/:owner/:repo/pulls/:number",
  {
    params: PullPath,
    success: PullDetail,
    error: [RepoNotFound, PullNotFound],
  },
);

/** Patches title/body, or closes/reopens via `state`. */
export const UpdatePull = HttpApiEndpoint.patch(
  "update",
  "/repos/:owner/:repo/pulls/:number",
  {
    params: PullPath,
    payload: Schema.Struct({
      title: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
      /** `null` clears the body. */
      body: Schema.optional(Schema.NullOr(Schema.String)),
      /**
       * `closed` closes an open PR; `open` reopens a closed one. Merged
       * PRs reject both (409).
       */
      state: Schema.optional(Schema.Literals(["open", "closed"])),
    }),
    success: Pull,
    error: [RepoNotFound, PullNotFound, PullStateConflict],
  },
);

/**
 * Merges an open PR: fast-forward when possible, else a merge commit iff
 * the three-way tree merge is trivial.
 */
export const MergePull = HttpApiEndpoint.post(
  "merge",
  "/repos/:owner/:repo/pulls/:number/merge",
  {
    params: PullPath,
    payload: Schema.Struct({
      /**
       * Merge-commit message; defaults to
       * `Merge pull request #N from <head>`. Ignored on fast-forward.
       */
      message: Schema.optional(Schema.String),
      /**
       * Race guard: fail RefConflict if the head tip moved (force-push)
       * since the caller inspected it.
       */
      expectedHeadOid: Schema.optional(Oid),
    }),
    success: MergeResult,
    error: [
      PushDenied,
      RepoNotFound,
      PullNotFound,
      PullStateConflict,
      BranchMissing,
      NothingToMerge,
      MergeConflict,
      RefConflict,
      ReadOnlyRepo,
    ],
  },
);

/** The `pulls` group, mounted at `/api/v1`. */
export class Pulls extends HttpApiGroup.make("pulls")
  .add(CreatePull, ListPulls, GetPull, UpdatePull, MergePull)
  .prefix("/api/v1") {}
