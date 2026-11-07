import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type * as Artifacts from "./Namespace.ts";

/**
 * Bind a Cloudflare Artifacts namespace ({@link Namespace}) to a Worker and
 * obtain the Effect-native {@link ReadWriteNamespaceClient} (read + write:
 * create / list / get / delete / import). Repos looked up with `get` carry
 * the full {@link RepoClient}: history and file reads plus token and fork
 * management.
 *
 * ### Creating repos and tokens
 * **Example:** Create a repo inside a Worker
 * ```typescript
 * const artifacts = yield* Cloudflare.Artifacts.ReadWriteNamespace(Repos);
 * const repo = yield* artifacts.create("starter-repo", {
 *   setDefaultBranch: "main",
 * });
 * ```
 *
 * **Example:** Mint a short-lived read token for an existing repo
 * ```typescript
 * const repo = yield* artifacts.get("starter-repo");
 * const token = yield* repo.createToken("read", 3600);
 * ```
 *
 * ### Reading history and files
 * **Example:** List the latest commits on a branch
 * ```typescript
 * const repo = yield* artifacts.get("starter-repo");
 * const commits = yield* repo.log({ ref: "main", limit: 10 });
 * // [{ hash, treeHash, message, author, committer, parents, authoredAt, committedAt }]
 * ```
 *
 * **Example:** Read a file at a ref
 * ```typescript
 * const file = yield* repo.readFile({ ref: "main", path: "README.md" });
 * if (file !== null) {
 *   const text = yield* Effect.promise(() => file.text());
 * }
 * ```
 *
 * **Example:** Walk a commit's tree
 * ```typescript
 * const commit = yield* repo.readCommit(hash);
 * const entries = commit ? yield* repo.readTree(commit.treeHash) : null;
 * const blob = entries?.find((e) => e.name === "data.json");
 * const bytes = blob ? yield* repo.readBlob(blob.hash) : null;
 * ```
 *
 * ### Handling errors
 * **Example:** Branch on the platform error code
 * ```typescript
 * const repo = yield* artifacts.get(name).pipe(
 *   Effect.catchTag("ArtifactsError", (e) =>
 *     e.code === "NOT_FOUND" ? Effect.succeed(undefined) : Effect.fail(e),
 *   ),
 * );
 * ```
 *
 * @binding
 * @product Artifacts
 * @category Developer Platform
 */
export interface ReadWriteNamespace extends Binding.Service<
  ReadWriteNamespace,
  "Cloudflare.Artifacts.ReadWriteNamespace",
  (namespace: Artifacts.Namespace) => Effect.Effect<ReadWriteNamespaceClient>
> {}

export const ReadWriteNamespace = Binding.Service<ReadWriteNamespace>(
  "Cloudflare.Artifacts.ReadWriteNamespace",
);

/**
 * Error codes the Artifacts binding attaches to a thrown error as `.code`.
 * See the {@link https://developers.cloudflare.com/artifacts/api/errors/ | Artifacts errors reference}.
 */
export type ArtifactsErrorCode = globalThis.ArtifactsErrorCode;

/**
 * Failure of an Artifacts binding call. `code` and `numericCode` carry the
 * platform's error code when the binding attached one, so callers can tell a
 * missing repo (`NOT_FOUND`) or a repo that is still importing
 * (`IMPORT_IN_PROGRESS`) from an outage (`INTERNAL_ERROR`). Both are
 * `undefined` when the failure carried no code (e.g. a dropped RPC
 * connection).
 */
export class ArtifactsError extends Data.TaggedError("ArtifactsError")<{
  message: string;
  /** Platform error code, when the binding attached one. */
  code?: ArtifactsErrorCode;
  /** Numeric code matching the REST API's `errors[].code`, when attached. */
  numericCode?: number;
  cause: Error;
}> {}

export type Scope = "read" | "write";

export type CreateOptions = {
  readOnly?: boolean;
  description?: string;
  setDefaultBranch?: string;
};

export type ImportOptions = {
  source: { url: string; branch?: string; depth?: number };
  target: {
    name: string;
    opts?: { description?: string; readOnly?: boolean };
  };
};

export type ListOptions = {
  limit?: number;
  cursor?: string;
};

export type ForkOptions = {
  description?: string;
  readOnly?: boolean;
  defaultBranchOnly?: boolean;
};

export type LogOptions = {
  /**
   * Branch, tag, or commit ID to walk from.
   * @default "HEAD"
   */
  ref?: string;
  /**
   * Maximum number of commits to return (capped at 1000 by the platform).
   * @default 50
   */
  limit?: number;
  /**
   * Number of matching commits to skip.
   * @default 0
   */
  offset?: number;
};

export type ReadFileOptions = {
  /** Branch, tag, or commit ID to resolve. */
  ref: string;
  /** Non-empty repository-relative path. */
  path: string;
};

/**
 * Classification of a Git tree entry, derived from its mode: `tree` is a
 * directory, `blob` a regular file, `symlink` a symbolic link, `gitlink` a
 * submodule reference, and `exec` an executable file.
 */
export type TreeEntryType = ArtifactsTreeEntryType;

/** An immediate child of a Git tree, as returned by `readTree`. */
export type TreeEntry = ArtifactsTreeEntry;

/** An author or committer identity on a commit. */
export type CommitIdentity = ArtifactsCommitMetadata["author"];

/** Decoded commit metadata, as returned by `log` and `readCommit`. */
export type CommitMetadata = ArtifactsCommitMetadata;

/**
 * The runtime repo capability returned by the binding's `get(name)`: an RPC
 * stub whose metadata comes from `info()` rather than from properties.
 */
export type RepoHandle = ArtifactsRepo;

/**
 * Read surface of a single Artifacts repo: metadata, token listing, commit
 * history, and Git object / file reads. Handed out by
 * {@link ReadNamespaceClient.get}.
 */
export interface ReadRepoClient {
  /** Underlying Cloudflare runtime handle. */
  raw: RepoHandle;
  /** Current repo metadata. Each call performs a fresh lookup. */
  info(): Effect.Effect<ArtifactsRepoInfo, ArtifactsError, RuntimeContext>;
  /** Token metadata for this repo (no plaintext). */
  listTokens(): Effect.Effect<ArtifactsTokenListResult, ArtifactsError, RuntimeContext>;
  /**
   * Commits along the first-parent chain from `ref`, newest first. Empty when
   * the ref cannot be resolved.
   */
  log(opts?: LogOptions): Effect.Effect<CommitMetadata[], ArtifactsError, RuntimeContext>;
  /** Decode a commit by hash; `null` when the object is missing. */
  readCommit(hash: string): Effect.Effect<CommitMetadata | null, ArtifactsError, RuntimeContext>;
  /** Immediate children of a tree by hash; `null` when the object is missing. */
  readTree(hash: string): Effect.Effect<TreeEntry[] | null, ArtifactsError, RuntimeContext>;
  /**
   * Raw bytes of a blob by hash (untyped `Blob`); `null` when the object is
   * missing or is not a blob.
   */
  readBlob(hash: string): Effect.Effect<Blob | null, ArtifactsError, RuntimeContext>;
  /**
   * A file resolved from a branch, tag, or commit ID, as a MIME-typed `Blob`;
   * `null` when the ref or path does not resolve to a file.
   */
  readFile(args: ReadFileOptions): Effect.Effect<Blob | null, ArtifactsError, RuntimeContext>;
}

/**
 * Write surface of a single Artifacts repo: minting and revoking tokens, and
 * forking.
 */
export interface WriteRepoClient {
  /** Underlying Cloudflare runtime handle. */
  raw: RepoHandle;
  createToken(
    scope?: Scope,
    ttl?: number,
  ): Effect.Effect<ArtifactsCreateTokenResult, ArtifactsError, RuntimeContext>;
  revokeToken(tokenOrId: string): Effect.Effect<boolean, ArtifactsError, RuntimeContext>;
  fork(
    name: string,
    opts?: ForkOptions,
  ): Effect.Effect<ArtifactsCreateRepoResult, ArtifactsError, RuntimeContext>;
}

/**
 * Effect-native handle to a single Artifacts repo with read and write access.
 * Wraps the runtime {@link RepoHandle} so each method returns an Effect.
 */
export interface RepoClient extends ReadRepoClient, WriteRepoClient {}

/**
 * Read-only client surface for an Artifacts namespace binding (look up + list).
 */
export interface ReadNamespaceClient {
  /** Effect resolving to the raw Cloudflare runtime binding. */
  raw: Effect.Effect<Artifacts, never, RuntimeContext>;
  /**
   * Look up an existing repo by name. Fails with an `ArtifactsError` whose
   * `code` is `NOT_FOUND` when the repo does not exist, or
   * `CREATE_IN_PROGRESS` / `IMPORT_IN_PROGRESS` / `FORK_IN_PROGRESS` while it
   * is not ready yet.
   */
  get(name: string): Effect.Effect<ReadRepoClient, ArtifactsError, RuntimeContext>;
  list(opts?: ListOptions): Effect.Effect<ArtifactsRepoListResult, ArtifactsError, RuntimeContext>;
}

/**
 * Write client surface for an Artifacts namespace binding (create / delete / import).
 */
export interface WriteNamespaceClient {
  /** Effect resolving to the raw Cloudflare runtime binding. */
  raw: Effect.Effect<Artifacts, never, RuntimeContext>;
  create(
    name: string,
    opts?: CreateOptions,
  ): Effect.Effect<ArtifactsCreateRepoResult, ArtifactsError, RuntimeContext>;
  delete(name: string): Effect.Effect<boolean, ArtifactsError, RuntimeContext>;
  import(
    opts: ImportOptions,
  ): Effect.Effect<ArtifactsCreateRepoResult, ArtifactsError, RuntimeContext>;
}

/**
 * Full read + write client for a Cloudflare Artifacts namespace binding.
 */
export interface ReadWriteNamespaceClient extends ReadNamespaceClient, WriteNamespaceClient {
  /**
   * Look up an existing repo by name, with read and write access. Fails with
   * an `ArtifactsError` whose `code` is `NOT_FOUND` when the repo does not
   * exist.
   */
  get(name: string): Effect.Effect<RepoClient, ArtifactsError, RuntimeContext>;
}

/**
 * Bind a Cloudflare Artifacts namespace with read-only access
 * (`Cloudflare.Artifacts.ReadNamespace(Repos)`): `get` / `list` / `raw`. Repos
 * returned by `get` expose the {@link ReadRepoClient} surface — metadata,
 * commit history, and file reads.
 *
 * ### Reading history
 * **Example:** Read a file at an older commit
 * ```typescript
 * const artifacts = yield* Cloudflare.Artifacts.ReadNamespace(Repos);
 * const repo = yield* artifacts.get("starter-repo");
 * const [, previous] = yield* repo.log({ ref: "main", limit: 2 });
 * const file = previous
 *   ? yield* repo.readFile({ ref: previous.hash, path: "data.json" })
 *   : null;
 * ```
 *
 * @binding
 * @product Artifacts
 * @category Developer Platform
 */
export interface ReadNamespace extends Binding.Service<
  ReadNamespace,
  "Cloudflare.Artifacts.ReadNamespace",
  (namespace: Artifacts.Namespace) => Effect.Effect<ReadNamespaceClient>
> {}
export const ReadNamespace = Binding.Service<ReadNamespace>("Cloudflare.Artifacts.ReadNamespace");

/**
 * Bind a Cloudflare Artifacts namespace with write access
 * (`Cloudflare.Artifacts.WriteNamespace(Repos)`): `create` / `delete` / `import`.
 *
 * @binding
 * @product Artifacts
 * @category Developer Platform
 */
export interface WriteNamespace extends Binding.Service<
  WriteNamespace,
  "Cloudflare.Artifacts.WriteNamespace",
  (namespace: Artifacts.Namespace) => Effect.Effect<WriteNamespaceClient>
> {}
export const WriteNamespace = Binding.Service<WriteNamespace>(
  "Cloudflare.Artifacts.WriteNamespace",
);
