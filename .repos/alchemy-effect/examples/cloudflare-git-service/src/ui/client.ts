/**
 * Plain-fetch client of the git-service REST API (`/api/v1`).
 *
 * The types mirror `alchemy/Git`'s API schemas (`src/Git/Api/Schema.ts`)
 * by hand — the SPA deliberately ships no Effect runtime; it is an example
 * of consuming the service from any plain JS frontend.
 */

// ── configuration ───────────────────────────────────────────────────────────

const builtinUrl: string | undefined = import.meta.env.VITE_GIT_URL;

/**
 * Where the service lives. Same origin as the SPA in the single-origin
 * deployment, so the Better Auth session cookie rides along with every
 * request (`credentials: "include"`).
 */
export interface Connection {
  readonly url: string;
}

export const getConnection = (): Connection => ({
  url: (builtinUrl ?? location.origin).replace(/\/+$/, ""),
});

// ── auth (Better Auth, mounted at /api/auth) ────────────────────────────────

export interface User {
  readonly id: string;
  readonly name: string;
  readonly email: string;
}

const authRequest = async <T>(
  c: Connection,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> => {
  const res = await fetch(`${c.url}/api/auth${path}`, {
    method,
    credentials: "include",
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    let message = text;
    try {
      message = (JSON.parse(text) as { message?: string }).message ?? text;
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, "AuthError", message || res.statusText);
  }
  const text = await res.text();
  return (text.length === 0 ? null : JSON.parse(text)) as T;
};

export const getSession = (c: Connection): Promise<User | null> =>
  authRequest<{ user: User } | null>(c, "GET", "/get-session").then(
    (session) => session?.user ?? null,
  );

export const signUp = (
  c: Connection,
  input: { name: string; email: string; password: string },
): Promise<User> =>
  authRequest<{ user: User }>(c, "POST", "/sign-up/email", input).then(
    (r) => r.user,
  );

export const signIn = (
  c: Connection,
  input: { email: string; password: string },
): Promise<User> =>
  authRequest<{ user: User }>(c, "POST", "/sign-in/email", input).then(
    (r) => r.user,
  );

export const signOut = (c: Connection): Promise<void> =>
  authRequest<unknown>(c, "POST", "/sign-out", {}).then(() => undefined);

/** An API key: the password a `git` remote carries. Values are shown once. */
export interface ApiKey {
  readonly id: string;
  readonly name: string | null;
  /** The first characters of the key, for recognition. */
  readonly start: string | null;
  readonly createdAt: string;
  readonly expiresAt: string | null;
}

export const listApiKeys = (c: Connection): Promise<ApiKey[]> =>
  authRequest<ApiKey[]>(c, "GET", "/api-key/list");

export const createApiKey = (
  c: Connection,
  name: string,
): Promise<ApiKey & { key: string }> =>
  authRequest(c, "POST", "/api-key/create", { name });

export const deleteApiKey = (c: Connection, keyId: string): Promise<void> =>
  authRequest<unknown>(c, "POST", "/api-key/delete", { keyId }).then(
    () => undefined,
  );

export type RepoStatus = "ready" | "importing" | "forking" | "deleting";

export interface ObjectStats {
  loose: number;
  packed: number;
  r2: number;
  bytes: number;
}

export interface PushStats {
  objects: number;
  bytes: number;
  ingestMs: number;
  stageMs: number;
  connectivityMs: number;
  finalizeMs: number;
  totalMs: number;
}

export interface Repo {
  owner: string;
  name: string;
  repoId: string;
  defaultBranch: string;
  description: string | null;
  readOnly: boolean;
  /** Readable (REST + clone) without signing in. */
  public: boolean;
  forkOf: string | null;
  status: RepoStatus;
  createdAt: number;
  objects: ObjectStats;
  lastPush: PushStats | null;
}

export interface Ref {
  name: string;
  oid: string;
  peeled?: string;
}

export interface Signature {
  name: string;
  email: string;
  /** Unix timestamp (seconds). */
  date: number;
  /** Timezone offset as written, e.g. `+0200`. */
  tz: string;
}

export interface CommitInfo {
  oid: string;
  tree: string;
  parents: string[];
  author: Signature;
  committer: Signature;
  message: string;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
  type: "blob" | "tree" | "commit";
}

export type FileStatus = "added" | "removed" | "modified";

/**
 * One changed file in a commit diff or comparison. Content is NOT
 * included — clients fetch old/new blobs by oid (`getBlob`) and diff
 * locally. `oldSize`/`newSize` gate binary/oversize files without a
 * round trip. Gitlinks (mode `160000`) carry commit oids — render
 * "Subproject commit …", never fetch them as blobs. No rename detection
 * in v1 (a rename is `removed` + `added`); a mode-only change is
 * `modified` with `oldOid === newOid`.
 */
export interface DiffEntry {
  path: string;
  status: FileStatus;
  oldOid?: string | null;
  newOid?: string | null;
  oldMode?: string | null;
  newMode?: string | null;
  oldSize?: number | null;
  newSize?: number | null;
}

/** Changed files of one commit vs its FIRST parent (null for a root commit). */
export interface CommitDiff {
  oid: string;
  parent: string | null;
  files: DiffEntry[];
  /** `true` when the list was cut at the server cap (1000 files). */
  truncated: boolean;
}

/** GitHub-style three-dot comparison of two revisions. */
export interface Comparison {
  base: string;
  head: string;
  mergeBase: string;
  aheadBy: number;
  behindBy: number;
  /** Head-side commits, committer-time descending, capped at 250. */
  commits: CommitInfo[];
  commitsTruncated: boolean;
  /** File diff of mergeBase..head (three-dot). */
  files: DiffEntry[];
  filesTruncated: boolean;
}

export interface RepoCreated {
  repo: Repo;
  remote: string;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

// ── errors ──────────────────────────────────────────────────────────────────

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly tag: string,
    override readonly message: string,
  ) {
    super(message);
  }
}

const parseError = async (res: Response): Promise<ApiError> => {
  let tag = `HTTP ${res.status}`;
  let message = res.statusText;
  try {
    const body: unknown = await res.clone().json();
    if (typeof body === "object" && body !== null) {
      const record = body as Record<string, unknown>;
      if (typeof record._tag === "string") tag = record._tag;
      if (typeof record.message === "string") message = record.message;
      else if (typeof record.reason === "string") message = record.reason;
    }
  } catch {
    try {
      message = (await res.text()) || message;
    } catch {
      /* keep statusText */
    }
  }
  return new ApiError(res.status, tag, message || tag);
};

// ── transport ───────────────────────────────────────────────────────────────

const request = async <T>(
  connection: Connection,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> => {
  const res = await fetch(`${connection.url}/api/v1${path}`, {
    method,
    // The Better Auth session cookie is the credential; anonymous
    // requests carry none and the policy confines them to public reads.
    credentials: "include",
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw await parseError(res);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text.length === 0 ? undefined : JSON.parse(text)) as T;
};

const seg = encodeURIComponent;

// ── repos ───────────────────────────────────────────────────────────────────

export const listRepos = (
  c: Connection,
  query?: { owner?: string; cursor?: string; limit?: number },
): Promise<Page<Repo>> => {
  const params = new URLSearchParams();
  if (query?.owner) params.set("owner", query.owner);
  if (query?.cursor) params.set("cursor", query.cursor);
  if (query?.limit) params.set("limit", String(query.limit));
  const qs = params.size > 0 ? `?${params}` : "";
  return request(c, "GET", `/repos${qs}`);
};

export const getRepo = (c: Connection, owner: string, repo: string) =>
  request<Repo>(c, "GET", `/repos/${seg(owner)}/${seg(repo)}`);

export const createRepo = (
  c: Connection,
  payload: {
    owner: string;
    name: string;
    description?: string;
    public?: boolean;
  },
) => request<RepoCreated>(c, "POST", `/repos`, payload);

export const updateRepo = (
  c: Connection,
  owner: string,
  repo: string,
  payload: {
    description?: string | null;
    defaultBranch?: string;
    readOnly?: boolean;
    public?: boolean;
  },
) => request<Repo>(c, "PATCH", `/repos/${seg(owner)}/${seg(repo)}`, payload);

export const deleteRepo = (c: Connection, owner: string, repo: string) =>
  request<unknown>(c, "DELETE", `/repos/${seg(owner)}/${seg(repo)}`);

export const compactRepo = (c: Connection, owner: string, repo: string) =>
  request<unknown>(c, "POST", `/repos/${seg(owner)}/${seg(repo)}/compact`);

// ── refs ────────────────────────────────────────────────────────────────────

export const listRefs = (c: Connection, owner: string, repo: string) =>
  request<{ head: string | null; refs: Ref[] }>(
    c,
    "GET",
    `/repos/${seg(owner)}/${seg(repo)}/refs`,
  );

// ── objects ─────────────────────────────────────────────────────────────────

export const getCommit = (
  c: Connection,
  owner: string,
  repo: string,
  oid: string,
) =>
  request<CommitInfo>(
    c,
    "GET",
    `/repos/${seg(owner)}/${seg(repo)}/commits/${seg(oid)}`,
  );

export const getLog = (
  c: Connection,
  owner: string,
  repo: string,
  query?: { ref?: string; cursor?: string; limit?: number },
): Promise<Page<CommitInfo>> => {
  const params = new URLSearchParams();
  if (query?.ref) params.set("ref", query.ref);
  if (query?.cursor) params.set("cursor", query.cursor);
  if (query?.limit) params.set("limit", String(query.limit));
  const qs = params.size > 0 ? `?${params}` : "";
  return request(c, "GET", `/repos/${seg(owner)}/${seg(repo)}/log${qs}`);
};

export const getTree = (
  c: Connection,
  owner: string,
  repo: string,
  oid: string,
) =>
  request<{ oid: string; entries: TreeEntry[] }>(
    c,
    "GET",
    `/repos/${seg(owner)}/${seg(repo)}/trees/${seg(oid)}`,
  );

/** Raw file bytes at `ref` + `path` (the streaming non-JSON route). */
export const getFile = async (
  c: Connection,
  owner: string,
  repo: string,
  options: { ref?: string; path: string },
): Promise<Uint8Array> => {
  const params = new URLSearchParams({ path: options.path });
  if (options.ref) params.set("ref", options.ref);
  const res = await fetch(
    `${c.url}/api/v1/repos/${seg(owner)}/${seg(repo)}/file?${params}`,
    {
      credentials: "include",
    },
  );
  if (!res.ok) throw await parseError(res);
  return new Uint8Array(await res.arrayBuffer());
};

/** Changed files of a commit vs its first parent (empty tree for a root). */
export const getCommitDiff = (
  c: Connection,
  owner: string,
  repo: string,
  oid: string,
) =>
  request<CommitDiff>(
    c,
    "GET",
    `/repos/${seg(owner)}/${seg(repo)}/commits/${seg(oid)}/diff`,
  );

/**
 * Three-dot comparison of two revisions (short/full refname or 40-hex
 * oid; annotated tags peeled): merge base, ahead/behind, head-side
 * commits, and the mergeBase..head file diff.
 */
export const compareCommits = (
  c: Connection,
  owner: string,
  repo: string,
  query: { base: string; head: string },
) => {
  const params = new URLSearchParams({ base: query.base, head: query.head });
  return request<Comparison>(
    c,
    "GET",
    `/repos/${seg(owner)}/${seg(repo)}/compare?${params}`,
  );
};

/** JSON blob endpoint serves ≤ 1 MiB only (422 beyond; use /raw). */
const MAX_JSON_BLOB = 1024 * 1024;

/** Raw blob bytes by oid (the streaming non-JSON route, any size). */
const getBlobRaw = async (
  c: Connection,
  owner: string,
  repo: string,
  oid: string,
): Promise<Uint8Array> => {
  const res = await fetch(
    `${c.url}/api/v1/repos/${seg(owner)}/${seg(repo)}/blobs/${seg(oid)}/raw`,
    { credentials: "include" },
  );
  if (!res.ok) throw await parseError(res);
  return new Uint8Array(await res.arrayBuffer());
};

/**
 * Blob bytes by oid. Uses the JSON base64 route for blobs ≤ 1 MiB and
 * falls back to `/raw` for bigger ones — pass `size` (known from a
 * {@link DiffEntry}) to skip the doomed JSON attempt entirely.
 */
export const getBlob = async (
  c: Connection,
  owner: string,
  repo: string,
  oid: string,
  options?: { size?: number },
): Promise<Uint8Array> => {
  if (options?.size !== undefined && options.size > MAX_JSON_BLOB) {
    return getBlobRaw(c, owner, repo, oid);
  }
  try {
    const json = await request<{
      oid: string;
      size: number;
      encoding: "base64";
      content: string;
    }>(c, "GET", `/repos/${seg(owner)}/${seg(repo)}/blobs/${seg(oid)}`);
    const binary = atob(json.content);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch (cause) {
    // ObjectTooLarge — the size hint was absent or stale; stream it raw.
    if (cause instanceof ApiError && cause.tag === "ObjectTooLarge") {
      return getBlobRaw(c, owner, repo, oid);
    }
    throw cause;
  }
};

// ── pull requests ───────────────────────────────────────────────────────────

export type PullState = "open" | "closed" | "merged";

/** Why `mergeable` is what it is (see {@link PullDetail}). */
export type MergeableReason =
  | "ff"
  | "merge-commit"
  | "conflict"
  | "up-to-date"
  | "unknown";

/**
 * A pull request. PRs track **live** branches by ref name — the record
 * stores intent + lifecycle, never a diff snapshot; diff and mergeability
 * are recomputed from current ref tips on every read.
 */
export interface Pull {
  /** Per-repo monotonic PR number (1-based, never reused). */
  number: number;
  title: string;
  body: string | null;
  /** Full base ref name, e.g. `refs/heads/main`. */
  baseRef: string;
  /** Full head ref name, e.g. `refs/heads/feature`. */
  headRef: string;
  state: PullState;
  /** Epoch milliseconds. */
  createdAt: number;
  updatedAt: number;
  /** Epoch milliseconds; `null` unless `state` is `merged`. */
  mergedAt: number | null;
  /** FF: the head tip; the merge commit otherwise. Set iff merged. */
  mergeCommit: string | null;
}

/**
 * PR detail = the row + live computed compare fields. Live fields are
 * `null` when uncomputable: a missing base/head branch, a saturated
 * ancestor walk, or a merged PR (its record is `mergeCommit`).
 */
export interface PullDetail extends Pull {
  /** Current tip of `baseRef`; `null` if the branch is gone. */
  baseOid: string | null;
  /** Current tip of `headRef`; `null` if the branch is gone. */
  headOid: string | null;
  mergeBase: string | null;
  /** Commits on head not on base (`null` when the walk saturates). */
  aheadBy: number | null;
  /** Commits on base not on head. */
  behindBy: number | null;
  /**
   * `true` = FF-able or trivially merge-able; `false` = conflicting
   * paths or up-to-date; `null` = uncomputable.
   */
  mergeable: boolean | null;
  mergeableReason: MergeableReason | null;
}

/** Response of a successful PR merge. */
export interface MergeResult {
  method: "ff" | "merge-commit";
  /** The oid the base ref now points at. */
  oid: string;
  /** The PR after the merge (`state: "merged"`). */
  pull: Pull;
}

/** Lists PRs, newest first. `state` defaults to `open` server-side. */
export const listPulls = (
  c: Connection,
  owner: string,
  repo: string,
  query?: {
    state?: PullState | "all";
    cursor?: string;
    limit?: number;
  },
): Promise<Page<Pull>> => {
  const params = new URLSearchParams();
  if (query?.state) params.set("state", query.state);
  if (query?.cursor) params.set("cursor", query.cursor);
  if (query?.limit) params.set("limit", String(query.limit));
  const qs = params.size > 0 ? `?${params}` : "";
  return request(c, "GET", `/repos/${seg(owner)}/${seg(repo)}/pulls${qs}`);
};

/** Reads one PR with live compare fields (ahead/behind/mergeable). */
export const getPull = (
  c: Connection,
  owner: string,
  repo: string,
  number: number,
) =>
  request<PullDetail>(
    c,
    "GET",
    `/repos/${seg(owner)}/${seg(repo)}/pulls/${number}`,
  );

/** Opens a PR. `base`/`head` accept short (`main`) or full branch names. */
export const createPull = (
  c: Connection,
  owner: string,
  repo: string,
  payload: { title: string; body?: string; base: string; head: string },
) =>
  request<Pull>(c, "POST", `/repos/${seg(owner)}/${seg(repo)}/pulls`, payload);

/** Patches title/body, or closes/reopens via `state`. */
export const updatePull = (
  c: Connection,
  owner: string,
  repo: string,
  number: number,
  payload: {
    title?: string;
    body?: string | null;
    state?: "open" | "closed";
  },
) =>
  request<Pull>(
    c,
    "PATCH",
    `/repos/${seg(owner)}/${seg(repo)}/pulls/${number}`,
    payload,
  );

/**
 * Merges an open PR: fast-forward when possible, else a merge commit iff
 * the three-way tree merge is trivial. `expectedHeadOid` guards against
 * a force-push racing the merge (409 RefConflict when stale).
 */
export const mergePull = (
  c: Connection,
  owner: string,
  repo: string,
  number: number,
  payload?: { message?: string; expectedHeadOid?: string },
) =>
  request<MergeResult>(
    c,
    "POST",
    `/repos/${seg(owner)}/${seg(repo)}/pulls/${number}/merge`,
    payload ?? {},
  );
