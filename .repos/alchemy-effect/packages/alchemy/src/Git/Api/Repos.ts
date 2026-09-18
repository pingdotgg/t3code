/**
 * The `repos` group: repo CRUD, fork, import, and compaction
 * (DESIGN.md §5). Every route is an Effect `HttpApiEndpoint`. Who may
 * call it is decided by the middleware applied to its route layer.
 */
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as Schema from "effect/Schema";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema";
import {
  ImportFailed,
  OwnerName,
  Paginated,
  RefNotFound,
  Repo,
  RepoAlreadyExists,
  RepoCreated,
  RepoName,
  RepoNotFound,
  RepoNotReady,
  RepoPath,
  ValidationError,
} from "./Schema.ts";

/** Creates a repo owned by `owner`. */
export const CreateRepo = HttpApiEndpoint.post("create", "/repos", {
  payload: Schema.Struct({
    owner: OwnerName,
    name: RepoName,
    /** Default branch short name. @default "main" */
    defaultBranch: Schema.optional(Schema.String),
    description: Schema.optional(Schema.String),
    /**
     * Anyone can read/clone without a credential when `true`.
     * @default false
     */
    public: Schema.optional(Schema.Boolean),
    /** @default false */
    readOnly: Schema.optional(Schema.Boolean),
  }),
  success: RepoCreated,
  error: [RepoAlreadyExists, ValidationError],
});

/** Reads one repo (poll `status` for async fork/import/delete progress). */
export const GetRepo = HttpApiEndpoint.get("get", "/repos/:owner/:repo", {
  params: RepoPath,
  success: Repo,
  error: [RepoNotFound],
});

/** Patches description / default branch / readOnly / public. */
export const UpdateRepo = HttpApiEndpoint.patch(
  "update",
  "/repos/:owner/:repo",
  {
    params: RepoPath,
    payload: Schema.Struct({
      description: Schema.optional(Schema.NullOr(Schema.String)),
      /** Must resolve to an existing branch. */
      defaultBranch: Schema.optional(Schema.String),
      readOnly: Schema.optional(Schema.Boolean),
      /** Anyone can read/clone without a credential when `true`. */
      public: Schema.optional(Schema.Boolean),
    }),
    success: Repo,
    error: [RepoNotFound, RefNotFound],
  },
);

/**
 * Lists repos, optionally filtered by owner. Lists everything the
 * Registry holds; `public: true` narrows it to public repositories.
 */
export const ListRepos = HttpApiEndpoint.get("list", "/repos", {
  query: Schema.Struct({
    owner: Schema.optional(OwnerName),
    /** Only public repositories when `true`. */
    public: Schema.optional(Schema.Boolean),
    cursor: Schema.optional(Schema.String),
    limit: Schema.optional(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
    ),
  }),
  success: Paginated(Repo),
});

/**
 * Deletes a repo. Async purge: responds 204 immediately, repo `status`
 * flips to `'deleting'`, the name frees after the purge alarm completes
 * (then 404).
 */
export const DeleteRepo = HttpApiEndpoint.delete(
  "delete",
  "/repos/:owner/:repo",
  {
    params: RepoPath,
    success: HttpApiSchema.NoContent,
    error: [RepoNotFound],
  },
);

/**
 * Forks a repo. The fork starts in `status: 'forking'`; poll
 * `GET /repos/:owner/:repo` until `'ready'`.
 */
export const ForkRepo = HttpApiEndpoint.post(
  "fork",
  "/repos/:owner/:repo/fork",
  {
    params: RepoPath,
    payload: Schema.Struct({
      targetOwner: OwnerName,
      targetName: RepoName,
    }),
    success: RepoCreated,
    error: [RepoNotFound, RepoAlreadyExists, RepoNotReady],
  },
);

/**
 * Imports from an external smart-HTTP source. The repo starts in
 * `status: 'importing'`; poll `GET /repos/:owner/:repo` until `'ready'`.
 */
export const ImportRepo = HttpApiEndpoint.post("import", "/repos/import", {
  payload: Schema.Struct({
    owner: OwnerName,
    name: RepoName,
    source: Schema.Struct({
      /** Smart-HTTP URL of the source repository. */
      url: Schema.String,
      /** Restrict the import to a single ref. */
      ref: Schema.optional(Schema.String),
      /** Depth-limit the imported history. */
      depth: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
    }),
  }),
  success: RepoCreated,
  error: [RepoAlreadyExists, ImportFailed],
});

/**
 * Forces a compaction run now (`Maintain`): moves loose object bytes into
 * an immutable pack. Normally armed automatically by size thresholds after
 * a push — this is the operator/benchmark handle. Returns immediately; poll
 * `GET /repos/:owner/:repo` and watch `objects.loose` fall to zero.
 */
export const CompactRepo = HttpApiEndpoint.post(
  "compact",
  "/repos/:owner/:repo/compact",
  {
    params: RepoPath,
    success: HttpApiSchema.NoContent,
    error: [RepoNotFound],
  },
);

/** The `repos` group, mounted at `/api/v1`. */
export class Repos extends HttpApiGroup.make("repos")
  .add(
    CreateRepo,
    GetRepo,
    UpdateRepo,
    ListRepos,
    DeleteRepo,
    ForkRepo,
    ImportRepo,
    CompactRepo,
  )
  .prefix("/api/v1") {}
