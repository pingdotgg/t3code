/**
 * The `objects` group: commit, log, tree, blob, diff, and compare reads,
 * plus the two raw streaming reads (DESIGN.md §5): a blob's bytes as an
 * octet-stream, and a file at a path under a ref. The raw routes declare
 * no success schema and answer with the response they build.
 */
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as Schema from "effect/Schema";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import {
  CommitDiff,
  CommitInfo,
  Comparison,
  NoMergeBase,
  ObjectNotFound,
  ObjectTooLarge,
  Oid,
  Paginated,
  RefNotFound,
  RepoNotFound,
  RepoOidPath,
  RepoPath,
  TreeEntry,
  WrongObjectType,
} from "./Schema.ts";

/** Reads one commit. */
export const GetCommit = HttpApiEndpoint.get(
  "commit",
  "/repos/:owner/:repo/commits/:oid",
  {
    params: RepoOidPath,
    success: CommitInfo,
    error: [RepoNotFound, ObjectNotFound, WrongObjectType],
  },
);

/** Pages the commit history from a ref or oid. */
export const GetLog = HttpApiEndpoint.get("log", "/repos/:owner/:repo/log", {
  params: RepoPath,
  query: Schema.Struct({
    /** Refname or oid to start from. @default HEAD */
    ref: Schema.optional(Schema.String),
    cursor: Schema.optional(Schema.String),
    limit: Schema.optional(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
    ),
  }),
  success: Paginated(CommitInfo),
  error: [RepoNotFound, RefNotFound],
});

/** Reads one tree's entries. */
export const GetTree = HttpApiEndpoint.get(
  "tree",
  "/repos/:owner/:repo/trees/:oid",
  {
    params: RepoOidPath,
    success: Schema.Struct({
      oid: Oid,
      entries: Schema.Array(TreeEntry),
    }),
    error: [RepoNotFound, ObjectNotFound, WrongObjectType],
  },
);

/** Reads a small blob as base64 JSON (≤ 1 MiB; 422 otherwise — use /raw). */
export const GetBlob = HttpApiEndpoint.get(
  "blob",
  "/repos/:owner/:repo/blobs/:oid",
  {
    params: RepoOidPath,
    success: Schema.Struct({
      oid: Oid,
      /** Uncompressed size in bytes. */
      size: Schema.Number,
      encoding: Schema.Literals(["base64"]),
      /** Base64 content — blobs ≤ 1 MiB only (422 otherwise; use /raw). */
      content: Schema.String,
    }),
    error: [RepoNotFound, ObjectNotFound, WrongObjectType, ObjectTooLarge],
  },
);

/**
 * The changed-file list of a commit vs its FIRST parent (empty tree for a
 * root commit). Merge commits are diffed against parent[0] only — the
 * GitHub default. No rename detection in v1: a rename appears as
 * `removed` + `added`; clients may pair entries whose old/new oids match
 * for a cheap exact-rename display.
 */
export const GetDiff = HttpApiEndpoint.get(
  "diff",
  "/repos/:owner/:repo/commits/:oid/diff",
  {
    params: RepoOidPath,
    success: CommitDiff,
    error: [RepoNotFound, ObjectNotFound, WrongObjectType],
  },
);

/**
 * Three-dot comparison: merge base, ahead/behind counts, head-side
 * commits, and the file diff of mergeBase..head. `base`/`head` accept a
 * refname (short or full) or a 40-hex oid; annotated tags are peeled.
 */
export const Compare = HttpApiEndpoint.get(
  "compare",
  "/repos/:owner/:repo/compare",
  {
    params: RepoPath,
    query: Schema.Struct({
      /** Refname or oid of the base side. */
      base: Schema.String,
      /** Refname or oid of the head side. */
      head: Schema.String,
    }),
    success: Comparison,
    error: [
      RepoNotFound,
      RefNotFound,
      ObjectNotFound,
      WrongObjectType,
      NoMergeBase,
    ],
  },
);

/**
 * A blob's bytes as an octet-stream, no size cap (the per-object 64 MiB
 * ingest cap is the outer bound). Streams the response it builds.
 */
export const GetBlobRaw = HttpApiEndpoint.get(
  "blobRaw",
  "/repos/:owner/:repo/blobs/:oid/raw",
  {},
);

/**
 * A file at `?path=` under `?ref=` (refname or oid; the default branch
 * when absent), walked tree by tree, as an octet-stream.
 */
export const GetFile = HttpApiEndpoint.get(
  "file",
  "/repos/:owner/:repo/file",
  {},
);

/** The `objects` group, mounted at `/api/v1`. */
export class Objects extends HttpApiGroup.make("objects")
  .add(
    GetCommit,
    GetLog,
    GetTree,
    GetBlob,
    GetDiff,
    Compare,
    GetBlobRaw,
    GetFile,
  )
  .prefix("/api/v1") {}
