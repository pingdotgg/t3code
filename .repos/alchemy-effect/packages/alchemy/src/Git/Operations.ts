/** Repository operations over storage services. HTTP handlers adapt these results. */
import type * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import type {
  CompactRepo,
  Compare,
  CreatePull,
  CreateRepo,
  DeleteRepo,
  ForkRepo,
  GetBlob,
  GetCommit,
  GetDiff,
  GetLog,
  GetPull,
  GetRef,
  GetRepo,
  GetTree,
  ImportRepo,
  ListPulls,
  ListRefs,
  ListRepos,
  MergePull,
  RemoveRef,
  UpdatePull,
  UpdateRef,
  UpdateRepo,
} from "./Api.ts";
import {
  CommitDiff,
  CommitInfo,
  Comparison,
  DiffEntry,
  ImportFailed,
  MergeResult,
  ObjectStats,
  ObjectTooLarge,
  Pull,
  PullDetail,
  PushStats,
  Ref,
  Repo,
  RepoAlreadyExists,
  RepoCreated,
  RepoNotFound,
  RepoNotReady,
  TreeEntry,
  type Oid,
} from "./Api.ts";

import {
  parseCommit,
  parseTree,
  treeEntryKind,
} from "./Protocol/ObjectCodec.ts";
import type { StoreError } from "./Protocol/Store.ts";
import { RegistryStore, type RegistryEntry } from "./RegistryObject.ts";
import {
  RepoStore,
  type CommitData,
  type DiffEntryData,
  type PullData,
  type PullDetailData,
  type RefData,
  type RepoMetaData,
} from "./RepoObject.ts";

/** TTL of the in-isolate `owner/name → repoId` cache (DESIGN.md §2.1). */
export const RESOLVE_CACHE_TTL_MS = 60_000;

/** Max entries of the in-isolate resolve cache (insertion-order eviction). */
export const RESOLVE_CACHE_MAX = 1024;

/** Blobs above this size are 422 on the JSON endpoint (use `/raw`). */
export const MAX_JSON_BLOB_BYTES = 1024 * 1024;

// ─────────────────────────────────────────────────────────────────────────────
// Pure mapping helpers
// ─────────────────────────────────────────────────────────────────────────────

const asOid = (value: string): Oid => value as Oid;

/** Maps the Repo DO's plain metadata onto the REST `Repo` schema class. */
const toRepo = (meta: RepoMetaData): Repo =>
  new Repo({
    owner: meta.owner,
    name: meta.name,
    repoId: meta.repoId,
    defaultBranch: meta.defaultBranch,
    description: meta.description,
    readOnly: meta.readOnly,
    public: meta.public,
    forkOf: meta.forkOf,
    status: meta.status,
    createdAt: meta.createdAt,
    objects: new ObjectStats(meta.objects),
    lastPush: meta.lastPush === null ? null : new PushStats(meta.lastPush),
  });

/** Maps a DO ref onto the REST `Ref` schema class. */
const toRef = (ref: RefData): Ref =>
  ref.peeled === undefined
    ? new Ref({ name: ref.name, oid: asOid(ref.oid) })
    : new Ref({
        name: ref.name,
        oid: asOid(ref.oid),
        peeled: asOid(ref.peeled),
      });

/** Maps a DO diff entry onto the REST `DiffEntry` schema class. */
const toDiffEntry = (entry: DiffEntryData): DiffEntry =>
  new DiffEntry({
    path: entry.path,
    status: entry.status,
    oldOid: entry.oldOid === undefined ? undefined : asOid(entry.oldOid),
    newOid: entry.newOid === undefined ? undefined : asOid(entry.newOid),
    oldMode: entry.oldMode,
    newMode: entry.newMode,
    oldSize: entry.oldSize,
    newSize: entry.newSize,
  });

/** Maps a DO pull row onto the REST `Pull` schema class. */
const toPull = (pull: PullData): Pull =>
  new Pull({
    number: pull.number,
    title: pull.title,
    body: pull.body,
    baseRef: pull.baseRef,
    headRef: pull.headRef,
    state: pull.state,
    createdAt: pull.createdAt,
    updatedAt: pull.updatedAt,
    mergedAt: pull.mergedAt,
    mergeCommit: pull.mergeCommit === null ? null : asOid(pull.mergeCommit),
  });

/** Maps a DO pull detail onto the REST `PullDetail` schema class. */
const toPullDetail = (pull: PullDetailData): PullDetail =>
  new PullDetail({
    number: pull.number,
    title: pull.title,
    body: pull.body,
    baseRef: pull.baseRef,
    headRef: pull.headRef,
    state: pull.state,
    createdAt: pull.createdAt,
    updatedAt: pull.updatedAt,
    mergedAt: pull.mergedAt,
    mergeCommit: pull.mergeCommit === null ? null : asOid(pull.mergeCommit),
    baseOid: pull.baseOid === null ? null : asOid(pull.baseOid),
    headOid: pull.headOid === null ? null : asOid(pull.headOid),
    mergeBase: pull.mergeBase === null ? null : asOid(pull.mergeBase),
    aheadBy: pull.aheadBy,
    behindBy: pull.behindBy,
    mergeable: pull.mergeable,
    mergeableReason: pull.mergeableReason,
  });

/** Maps a DO commit onto the REST `CommitInfo` schema class. */
const toCommitInfo = (commit: CommitData): CommitInfo =>
  new CommitInfo({
    oid: asOid(commit.oid),
    tree: asOid(commit.tree),
    parents: commit.parents.map(asOid),
    author: commit.author,
    committer: commit.committer,
    message: commit.message,
  });

/**
 * Registry-derived fallback `Repo` for list pages when a Repo DO cannot be
 * consulted (e.g. its config was never seeded because the create crashed
 * between the Registry insert and `initRepo`).
 */
const registryFallbackRepo = (entry: RegistryEntry): Repo =>
  new Repo({
    owner: entry.owner,
    name: entry.name,
    repoId: entry.repoId,
    defaultBranch: entry.defaultBranch,
    description: entry.description,
    readOnly: entry.readOnly,
    public: entry.public,
    forkOf: entry.forkOf,
    status:
      entry.deletedAt !== null ? "deleting" : (entry.status as Repo["status"]),
    createdAt: entry.createdAt,
    // No DO to ask (unseeded or mid-purge) — report an empty store.
    objects: new ObjectStats({
      loose: 0,
      resident: 0,
      packed: 0,
      r2: 0,
      bytes: 0,
    }),
    lastPush: null,
  });

export const makeOperations = Effect.gen(function* () {
  const registry = yield* RegistryStore;
  const repos = yield* RepoStore;
  // The registry block, whichever backend the assembly provided.
  const registryStub = () => registry;

  // ── owner/name → RegistryEntry, 60 s in-isolate LRU (DESIGN.md §2.1) ──
  // A stale hit fails safe: the Repo DO stores its own (owner, name) and
  // 404s mismatched requests, and cache entries are dropped on delete.
  interface CacheSlot {
    readonly entry: RegistryEntry;
    readonly expires: number;
  }
  const resolveCache = new Map<string, CacheSlot>();

  const cacheKey = (owner: string, repo: string) =>
    `${owner.toLowerCase()}/${repo.toLowerCase()}`;

  const dropCached = (owner: string, repo: string) =>
    Effect.sync(() => {
      resolveCache.delete(cacheKey(owner, repo));
    });

  const resolveCached = (owner: string, repo: string) =>
    Effect.gen(function* () {
      const key = cacheKey(owner, repo);
      const now = yield* Effect.sync(() => Date.now());
      const hit = resolveCache.get(key);
      if (hit !== undefined && hit.expires > now) return hit.entry;
      const entry = yield* registryStub().resolve(owner, repo);
      // Rows mid-purge are transient (removed when the purge alarm
      // finishes) — never cache them, or a 60 s stale hit would keep
      // reporting "deleting" after the name has freed.
      if (entry !== undefined && entry.deletedAt === null) {
        yield* Effect.sync(() => {
          if (resolveCache.size >= RESOLVE_CACHE_MAX) {
            const oldest = resolveCache.keys().next().value;
            if (oldest !== undefined) resolveCache.delete(oldest);
          }
          resolveCache.set(key, {
            entry,
            expires: now + RESOLVE_CACHE_TTL_MS,
          });
        });
      }
      return entry;
    });

  /**
   * Resolve including rows whose async purge is still draining
   * (`deletedAt` set) — only `repos.get` (report `status: "deleting"`)
   * and `repos.delete` (idempotent 204) want those.
   */
  const resolveIncludingDeleting = (owner: string, repo: string) =>
    resolveCached(owner, repo).pipe(
      Effect.catchTag("StoreError", (error: StoreError) => Effect.die(error)),
      Effect.flatMap((entry) =>
        entry === undefined
          ? Effect.fail(new RepoNotFound({ owner, repo }))
          : Effect.succeed(entry),
      ),
    );

  /**
   * Resolve or fail with a typed 404. Rows mid-purge count as gone for
   * every data-plane route (the name is reserved but the repo is dead).
   * Storage failures are defects.
   */
  const resolveOrNotFound = (owner: string, repo: string) =>
    resolveIncludingDeleting(owner, repo).pipe(
      Effect.filterOrFail(
        (entry) => entry.deletedAt === null,
        () => new RepoNotFound({ owner, repo }),
      ),
    );

  const remoteUrl = (owner: string, name: string) =>
    Effect.succeed(`/${owner}/${name}.git`);

  // Accept decoded fields rather than endpoint metadata so these handlers also
  // work with APIs that add middleware or prefixes.
  // ── REST handler groups ────────────────────────────────────────────────

  /**
   * Inserts the registry row, repairing an ORPHAN first: a row whose Repo
   * DO was never seeded (a create that died between the registry insert
   * and `initRepo`). An orphan poisons the name permanently — `GET` 404s
   * because the DO has no config, while `POST` 409s because the row
   * exists — so detect it (registry row present + DO reports
   * `RepoNotFound`), drop the row, and insert again.
   */
  const insertRepoRow = (input: {
    readonly owner: string;
    readonly name: string;
    readonly description?: string | undefined;
    readonly public?: boolean | undefined;
  }) =>
    registryStub()
      .createRepo(input)
      .pipe(
        Effect.catchTag("StoreError", (error) => Effect.die(error)),
        Effect.catchTag("RepoAlreadyExists", (conflict) =>
          Effect.gen(function* () {
            const existing = yield* resolveCached(input.owner, input.name).pipe(
              Effect.catchTag("StoreError", (error) => Effect.die(error)),
            );
            if (existing === undefined) {
              return yield* Effect.fail(conflict);
            }
            const orphaned = yield* repos
              .getByName(existing.repoId)
              .readMeta()
              .pipe(
                Effect.as(false),
                Effect.catchTag("RepoNotFound", () => Effect.succeed(true)),
                Effect.catchCause(() => Effect.succeed(false)),
              );
            if (!orphaned) {
              return yield* Effect.fail(conflict);
            }
            yield* registryStub()
              .removeRow(existing.repoId)
              .pipe(
                Effect.catchTag("StoreError", (error) => Effect.die(error)),
              );
            yield* dropCached(input.owner, input.name);
            return yield* registryStub()
              .createRepo(input)
              .pipe(
                Effect.catchTag("StoreError", (error) => Effect.die(error)),
              );
          }),
        ),
      );

  const reposRoutes = {
    create: ({
      payload,
    }: Pick<HttpApiEndpoint.Request<typeof CreateRepo>, "payload">) =>
      Effect.gen(function* () {
        const entry = yield* insertRepoRow({
          owner: payload.owner,
          name: payload.name,
          description: payload.description,
          public: payload.public,
        });
        const init = yield* repos
          .getByName(entry.repoId)
          .initRepo({
            repoId: entry.repoId,
            owner: entry.owner,
            name: entry.name,
            defaultBranch: payload.defaultBranch ?? "main",
            description: payload.description ?? null,
            readOnly: payload.readOnly ?? false,
            public: payload.public ?? false,
            forkOf: null,
          })
          .pipe(
            // Seeding the DO failed (or died): drop the row we just
            // inserted rather than leave an orphan behind.
            Effect.onError(() =>
              registryStub()
                .removeRow(entry.repoId)
                .pipe(
                  Effect.ignore,
                  Effect.andThen(dropCached(entry.owner, entry.name)),
                ),
            ),
            Effect.catchTag("StoreError", (error) => Effect.die(error)),
          );
        const remote = yield* remoteUrl(entry.owner, entry.name);
        return new RepoCreated({
          repo: toRepo(init.meta),
          remote,
        });
      }),
    get: ({
      params,
    }: Pick<HttpApiEndpoint.Request<typeof GetRepo>, "params">) =>
      Effect.gen(function* () {
        // Includes rows mid-purge: GET keeps reporting
        // status "deleting" until the purge alarm frees the name (only
        // then a 404), so "poll GET until 404 then re-create" never
        // races the purge.
        const entry = yield* resolveIncludingDeleting(
          params.owner,
          params.repo,
        );
        if (entry.deletedAt !== null) {
          return registryFallbackRepo(entry);
        }
        const meta = yield* repos
          .getByName(entry.repoId)
          .getRepoMeta()
          .pipe(
            Effect.catchTag("StoreError", (error) => Effect.die(error)),
            Effect.catchTag("RepoNotFound", () =>
              Effect.fail(
                new RepoNotFound({
                  owner: params.owner,
                  repo: params.repo,
                }),
              ),
            ),
          );
        return toRepo(meta);
      }),
    update: ({
      params,
      payload,
    }: Pick<
      HttpApiEndpoint.Request<typeof UpdateRepo>,
      "params" | "payload"
    >) =>
      Effect.gen(function* () {
        const entry = yield* resolveOrNotFound(params.owner, params.repo);
        const meta = yield* repos
          .getByName(entry.repoId)
          .updateRepoMeta({
            description: payload.description,
            defaultBranch: payload.defaultBranch,
            readOnly: payload.readOnly,
            public: payload.public,
          })
          .pipe(
            Effect.catchTag("StoreError", (error) => Effect.die(error)),
            Effect.catchTag("RepoNotFound", () =>
              Effect.fail(
                new RepoNotFound({
                  owner: params.owner,
                  repo: params.repo,
                }),
              ),
            ),
          );
        return toRepo(meta);
      }),
    list: ({
      query,
    }: Pick<HttpApiEndpoint.Request<typeof ListRepos>, "query">) =>
      Effect.gen(function* () {
        // Everything the Registry holds; `public: true` narrows it. Who
        // may list at all was decided in front of the route.
        const page = yield* registryStub()
          .list({
            owner: query.owner,
            cursor: query.cursor,
            limit: query.limit,
            publicOnly: query.public === true,
          })
          .pipe(Effect.catchTag("StoreError", (error) => Effect.die(error)));
        // Rendered straight from the Registry's denormalised columns:
        // listing must NOT wake one Durable Object per row (measured at
        // ~30 ms per row — DESIGN.md §14.1 / §15 bottleneck 7). Live
        // `objects` stats need the DO, so a listing reports zeros and
        // callers who want them read the repo directly.
        const items = page.items.map(registryFallbackRepo);
        return {
          items,
          nextCursor: page.nextCursor,
          hasMore: page.hasMore,
        };
      }),
    delete: ({
      params,
    }: Pick<HttpApiEndpoint.Request<typeof DeleteRepo>, "params">) =>
      Effect.gen(function* () {
        const entry = yield* resolveIncludingDeleting(
          params.owner,
          params.repo,
        );
        // Always (re-)arm the purge — even when the row is already
        // soft-deleted. A second DELETE mid-drain is an idempotent 204,
        // and re-arming is what recovers a purge whose alarm was lost
        // (crash between markDeleted and the first alarm run).
        yield* repos
          .getByName(entry.repoId)
          .startPurge()
          .pipe(
            Effect.catchTag("StoreError", (error) => Effect.die(error)),
            // The registry row exists but the DO holds no state — an
            // orphan, or a purge that already wiped storage. There is
            // nothing to purge, so free the name directly (never 404:
            // the caller can see this repo, so DELETE must remove it).
            Effect.catchTag("RepoNotFound", () =>
              registryStub()
                .removeRow(entry.repoId)
                .pipe(
                  Effect.catchTag("StoreError", (error) => Effect.die(error)),
                ),
            ),
          );
        yield* registryStub()
          .markDeleted(entry.repoId)
          .pipe(Effect.catchTag("StoreError", (error) => Effect.die(error)));
        yield* dropCached(params.owner, params.repo);
      }),
    fork: ({
      params,
      payload,
    }: Pick<HttpApiEndpoint.Request<typeof ForkRepo>, "params" | "payload">) =>
      Effect.gen(function* () {
        const source = yield* resolveOrNotFound(params.owner, params.repo);
        const sourceMeta = yield* repos
          .getByName(source.repoId)
          .readMeta()
          .pipe(
            Effect.catchTag("StoreError", (error) => Effect.die(error)),
            Effect.catchTag("RepoNotFound", () =>
              Effect.fail(
                new RepoNotFound({
                  owner: params.owner,
                  repo: params.repo,
                }),
              ),
            ),
          );
        if (sourceMeta.status !== "ready") {
          return yield* new RepoNotReady({ status: sourceMeta.status });
        }
        const entry = yield* registryStub()
          .createRepo({
            owner: payload.targetOwner,
            name: payload.targetName,
            description: sourceMeta.description ?? undefined,
            forkOf: source.repoId,
          })
          .pipe(
            Effect.catchTag("StoreError", (error) => Effect.die(error)),
            // `fork` declares no ValidationError (reserved target
            // owner) — surface it as the closest declared conflict.
            Effect.catchTag("ValidationError", () =>
              Effect.fail(
                new RepoAlreadyExists({
                  owner: payload.targetOwner,
                  repo: payload.targetName,
                }),
              ),
            ),
          );
        const init = yield* repos
          .getByName(entry.repoId)
          .startFork({
            repoId: entry.repoId,
            owner: entry.owner,
            name: entry.name,
            defaultBranch: sourceMeta.defaultBranch,
            description: sourceMeta.description,
            readOnly: false,
            // Forks inherit the source's visibility.
            public: sourceMeta.public,
            forkOf: source.repoId,
            parentRepoId: source.repoId,
          })
          .pipe(Effect.catchTag("StoreError", (error) => Effect.die(error)));
        const remote = yield* remoteUrl(entry.owner, entry.name);
        return new RepoCreated({
          repo: toRepo(init.meta),
          remote,
        });
      }),
    compact: ({
      params,
    }: Pick<HttpApiEndpoint.Request<typeof CompactRepo>, "params">) =>
      Effect.gen(function* () {
        const entry = yield* resolveOrNotFound(params.owner, params.repo);
        yield* repos
          .getByName(entry.repoId)
          .startCompact()
          .pipe(
            Effect.catchTag("StoreError", (error) => Effect.die(error)),
            Effect.catchTag("RepoNotFound", () =>
              Effect.fail(
                new RepoNotFound({
                  owner: params.owner,
                  repo: params.repo,
                }),
              ),
            ),
          );
      }),
    import: ({
      payload,
    }: Pick<HttpApiEndpoint.Request<typeof ImportRepo>, "payload">) =>
      Effect.gen(function* () {
        const entry = yield* registryStub()
          .createRepo({
            owner: payload.owner,
            name: payload.name,
          })
          .pipe(
            Effect.catchTag("StoreError", (error) => Effect.die(error)),
            // `import` declares no ValidationError — a reserved owner
            // is an import that can never succeed.
            Effect.catchTag("ValidationError", (error) =>
              Effect.fail(new ImportFailed({ reason: error.message })),
            ),
          );
        const init = yield* repos
          .getByName(entry.repoId)
          .startImport({
            repoId: entry.repoId,
            owner: entry.owner,
            name: entry.name,
            defaultBranch: "main",
            description: null,
            readOnly: false,
            public: false,
            forkOf: null,
            source: {
              url: payload.source.url,
              ref: payload.source.ref,
              depth: payload.source.depth,
            },
          })
          .pipe(Effect.catchTag("StoreError", (error) => Effect.die(error)));
        const remote = yield* remoteUrl(entry.owner, entry.name);
        return new RepoCreated({
          repo: toRepo(init.meta),
          remote,
        });
      }),
  };

  const refsRoutes = {
    list: ({
      params,
      query,
    }: Pick<HttpApiEndpoint.Request<typeof ListRefs>, "params" | "query">) =>
      Effect.gen(function* () {
        const entry = yield* resolveOrNotFound(params.owner, params.repo);
        const page = yield* repos
          .getByName(entry.repoId)
          .listRefs(query.prefix)
          .pipe(
            Effect.catchTag("StoreError", (error) => Effect.die(error)),
            Effect.catchTag("RepoNotFound", () =>
              Effect.fail(
                new RepoNotFound({
                  owner: params.owner,
                  repo: params.repo,
                }),
              ),
            ),
          );
        return { head: page.head, refs: page.refs.map(toRef) };
      }),
    get: ({
      params,
      query,
    }: Pick<HttpApiEndpoint.Request<typeof GetRef>, "params" | "query">) =>
      Effect.gen(function* () {
        const entry = yield* resolveOrNotFound(params.owner, params.repo);
        const ref = yield* repos
          .getByName(entry.repoId)
          .getRef(query.name)
          .pipe(
            Effect.catchTag("StoreError", (error) => Effect.die(error)),
            Effect.catchTag("RepoNotFound", () =>
              Effect.fail(
                new RepoNotFound({
                  owner: params.owner,
                  repo: params.repo,
                }),
              ),
            ),
          );
        return toRef(ref);
      }),
    update: ({
      params,
      query,
      payload,
    }: Pick<
      HttpApiEndpoint.Request<typeof UpdateRef>,
      "params" | "query" | "payload"
    >) =>
      Effect.gen(function* () {
        const entry = yield* resolveOrNotFound(params.owner, params.repo);
        const stub = repos.getByName(entry.repoId);
        const ref = yield* stub
          .updateRef({
            name: query.name,
            newOid: payload.newOid,
            expectedOid: payload.expectedOid,
          })
          .pipe(
            Effect.catchTag("StoreError", (error) => Effect.die(error)),
            Effect.catchTag("RepoNotFound", () =>
              Effect.fail(
                new RepoNotFound({
                  owner: params.owner,
                  repo: params.repo,
                }),
              ),
            ),
          );
        return toRef(ref);
      }),
    remove: ({
      params,
      query,
      payload,
    }: Pick<
      HttpApiEndpoint.Request<typeof RemoveRef>,
      "params" | "query" | "payload"
    >) =>
      Effect.gen(function* () {
        const entry = yield* resolveOrNotFound(params.owner, params.repo);
        const stub = repos.getByName(entry.repoId);
        yield* stub
          .removeRef({
            name: query.name,
            expectedOid: payload.expectedOid,
          })
          .pipe(
            Effect.catchTag("StoreError", (error) => Effect.die(error)),
            Effect.catchTag("RepoNotFound", () =>
              Effect.fail(
                new RepoNotFound({
                  owner: params.owner,
                  repo: params.repo,
                }),
              ),
            ),
          );
      }),
  };

  const objectsRoutes = {
    commit: ({
      params,
    }: Pick<HttpApiEndpoint.Request<typeof GetCommit>, "params">) =>
      Effect.gen(function* () {
        const entry = yield* resolveOrNotFound(params.owner, params.repo);
        const data = yield* repos
          .getByName(entry.repoId)
          .readObject({ oid: params.oid, expect: "commit" })
          .pipe(
            Effect.catchTag("StoreError", (error) => Effect.die(error)),
            Effect.catchTag("RepoNotFound", () =>
              Effect.fail(
                new RepoNotFound({
                  owner: params.owner,
                  repo: params.repo,
                }),
              ),
            ),
          );
        // A stored commit that fails to parse is corrupt — a defect.
        const parsed = yield* parseCommit(data.content).pipe(Effect.orDie);
        return new CommitInfo({
          oid: params.oid,
          tree: asOid(parsed.tree),
          parents: parsed.parents.map(asOid),
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
      }),
    log: ({
      params,
      query,
    }: Pick<HttpApiEndpoint.Request<typeof GetLog>, "params" | "query">) =>
      Effect.gen(function* () {
        const entry = yield* resolveOrNotFound(params.owner, params.repo);
        const page = yield* repos
          .getByName(entry.repoId)
          .readCommitLog({
            ref: query.ref,
            cursor: query.cursor,
            limit: query.limit,
          })
          .pipe(
            Effect.catchTag("StoreError", (error) => Effect.die(error)),
            Effect.catchTag("RepoNotFound", () =>
              Effect.fail(
                new RepoNotFound({
                  owner: params.owner,
                  repo: params.repo,
                }),
              ),
            ),
          );
        return {
          items: page.items.map(toCommitInfo),
          nextCursor: page.nextCursor,
          hasMore: page.hasMore,
        };
      }),
    tree: ({
      params,
    }: Pick<HttpApiEndpoint.Request<typeof GetTree>, "params">) =>
      Effect.gen(function* () {
        const entry = yield* resolveOrNotFound(params.owner, params.repo);
        const data = yield* repos
          .getByName(entry.repoId)
          .readObject({ oid: params.oid, expect: "tree" })
          .pipe(
            Effect.catchTag("StoreError", (error) => Effect.die(error)),
            Effect.catchTag("RepoNotFound", () =>
              Effect.fail(
                new RepoNotFound({
                  owner: params.owner,
                  repo: params.repo,
                }),
              ),
            ),
          );
        const entries = yield* parseTree(data.content).pipe(Effect.orDie);
        return {
          oid: params.oid,
          entries: entries.map(
            (item) =>
              new TreeEntry({
                mode: item.mode,
                name: item.name,
                oid: asOid(item.oid),
                type: treeEntryKind(item.mode),
              }),
          ),
        };
      }),
    blob: ({
      params,
    }: Pick<HttpApiEndpoint.Request<typeof GetBlob>, "params">) =>
      Effect.gen(function* () {
        const entry = yield* resolveOrNotFound(params.owner, params.repo);
        const data = yield* repos
          .getByName(entry.repoId)
          .readObject({ oid: params.oid, expect: "blob" })
          .pipe(
            Effect.catchTag("StoreError", (error) => Effect.die(error)),
            Effect.catchTag("RepoNotFound", () =>
              Effect.fail(
                new RepoNotFound({
                  owner: params.owner,
                  repo: params.repo,
                }),
              ),
            ),
          );
        if (data.size > MAX_JSON_BLOB_BYTES) {
          return yield* new ObjectTooLarge({
            oid: params.oid,
            size: data.size,
          });
        }
        return {
          oid: params.oid,
          size: data.size,
          encoding: "base64" as const,
          content: Encoding.encodeBase64(data.content),
        };
      }),
    diff: ({
      params,
    }: Pick<HttpApiEndpoint.Request<typeof GetDiff>, "params">) =>
      Effect.gen(function* () {
        const entry = yield* resolveOrNotFound(params.owner, params.repo);
        const data = yield* repos
          .getByName(entry.repoId)
          .readCommitDiff({ oid: params.oid })
          .pipe(
            Effect.catchTag("StoreError", (error) => Effect.die(error)),
            Effect.catchTag("RepoNotFound", () =>
              Effect.fail(
                new RepoNotFound({
                  owner: params.owner,
                  repo: params.repo,
                }),
              ),
            ),
          );
        return new CommitDiff({
          oid: params.oid,
          parent: data.parent === null ? null : asOid(data.parent),
          files: data.files.map(toDiffEntry),
          truncated: data.truncated,
        });
      }),
    compare: ({
      params,
      query,
    }: Pick<HttpApiEndpoint.Request<typeof Compare>, "params" | "query">) =>
      Effect.gen(function* () {
        const entry = yield* resolveOrNotFound(params.owner, params.repo);
        const data = yield* repos
          .getByName(entry.repoId)
          .compareCommits({ base: query.base, head: query.head })
          .pipe(
            Effect.catchTag("StoreError", (error) => Effect.die(error)),
            Effect.catchTag("RepoNotFound", () =>
              Effect.fail(
                new RepoNotFound({
                  owner: params.owner,
                  repo: params.repo,
                }),
              ),
            ),
          );
        return new Comparison({
          base: asOid(data.base),
          head: asOid(data.head),
          mergeBase: asOid(data.mergeBase),
          aheadBy: data.aheadBy,
          behindBy: data.behindBy,
          commits: data.commits.map(toCommitInfo),
          commitsTruncated: data.commitsTruncated,
          files: data.files.map(toDiffEntry),
          filesTruncated: data.filesTruncated,
        });
      }),
  };

  const pullsRoutes = {
    create: ({
      params,
      payload,
    }: Pick<
      HttpApiEndpoint.Request<typeof CreatePull>,
      "params" | "payload"
    >) =>
      Effect.gen(function* () {
        const entry = yield* resolveOrNotFound(params.owner, params.repo);
        const pull = yield* repos
          .getByName(entry.repoId)
          .createPull({
            title: payload.title,
            body: payload.body,
            base: payload.base,
            head: payload.head,
          })
          .pipe(
            Effect.catchTag("StoreError", (error) => Effect.die(error)),
            Effect.catchTag("RepoNotFound", () =>
              Effect.fail(
                new RepoNotFound({
                  owner: params.owner,
                  repo: params.repo,
                }),
              ),
            ),
          );
        return toPull(pull);
      }),
    list: ({
      params,
      query,
    }: Pick<HttpApiEndpoint.Request<typeof ListPulls>, "params" | "query">) =>
      Effect.gen(function* () {
        const entry = yield* resolveOrNotFound(params.owner, params.repo);
        const page = yield* repos
          .getByName(entry.repoId)
          .listPulls({
            state: query.state,
            cursor: query.cursor,
            limit: query.limit,
          })
          .pipe(
            Effect.catchTag("StoreError", (error) => Effect.die(error)),
            Effect.catchTag("RepoNotFound", () =>
              Effect.fail(
                new RepoNotFound({
                  owner: params.owner,
                  repo: params.repo,
                }),
              ),
            ),
          );
        return {
          items: page.items.map(toPull),
          nextCursor: page.nextCursor,
          hasMore: page.hasMore,
        };
      }),
    get: ({
      params,
    }: Pick<HttpApiEndpoint.Request<typeof GetPull>, "params">) =>
      Effect.gen(function* () {
        const entry = yield* resolveOrNotFound(params.owner, params.repo);
        const detail = yield* repos
          .getByName(entry.repoId)
          .getPull(params.number)
          .pipe(
            Effect.catchTag("StoreError", (error) => Effect.die(error)),
            Effect.catchTag("RepoNotFound", () =>
              Effect.fail(
                new RepoNotFound({
                  owner: params.owner,
                  repo: params.repo,
                }),
              ),
            ),
          );
        return toPullDetail(detail);
      }),
    update: ({
      params,
      payload,
    }: Pick<
      HttpApiEndpoint.Request<typeof UpdatePull>,
      "params" | "payload"
    >) =>
      Effect.gen(function* () {
        const entry = yield* resolveOrNotFound(params.owner, params.repo);
        const pull = yield* repos
          .getByName(entry.repoId)
          .updatePull({
            number: params.number,
            title: payload.title,
            body: payload.body,
            state: payload.state,
          })
          .pipe(
            Effect.catchTag("StoreError", (error) => Effect.die(error)),
            Effect.catchTag("RepoNotFound", () =>
              Effect.fail(
                new RepoNotFound({
                  owner: params.owner,
                  repo: params.repo,
                }),
              ),
            ),
          );
        return toPull(pull);
      }),
    merge: ({
      params,
      payload,
    }: Pick<HttpApiEndpoint.Request<typeof MergePull>, "params" | "payload">) =>
      Effect.gen(function* () {
        const entry = yield* resolveOrNotFound(params.owner, params.repo);
        const stub = repos.getByName(entry.repoId);
        const result = yield* stub
          .mergePull({
            number: params.number,
            message: payload.message,
            expectedHeadOid: payload.expectedHeadOid,
          })
          .pipe(
            Effect.catchTag("StoreError", (error) => Effect.die(error)),
            Effect.catchTag("RepoNotFound", () =>
              Effect.fail(
                new RepoNotFound({
                  owner: params.owner,
                  repo: params.repo,
                }),
              ),
            ),
          );
        return new MergeResult({
          method: result.method,
          oid: asOid(result.oid),
          pull: toPull(result.pull),
        });
      }),
  };

  return {
    repos: reposRoutes,
    refs: refsRoutes,
    objects: objectsRoutes,
    pulls: pullsRoutes,
    resolveCached,
  };
});
/** @internal Shared operations/cache used by the engine and default HTTP adapters. */
export class Operations extends Context.Service<
  Operations,
  Effect.Success<typeof makeOperations>
>()("alchemy/Git/Operations") {}
export const OperationsLive = Layer.effect(Operations, makeOperations);
