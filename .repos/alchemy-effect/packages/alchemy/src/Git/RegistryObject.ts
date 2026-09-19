/**
 * The singleton Registry Durable Object (DESIGN.md §2.1, §3.1).
 *
 * The Registry is the control-plane authority for the `owner/name → repoId`
 * mapping: uniqueness CAS at creation, the listing surface, and the
 * fork-lineage ledger (`fork_of`, `fork_count`). It is addressed as a
 * singleton via `getByName(REGISTRY_DO_NAME)`; the sharding seam
 * (`getByName("registry:" + owner)`) changes no RPC interface.
 *
 * Repo ids are ULIDs minted here at creation — **not** `owner/name` — so
 * renames never move data and a deleted-then-recreated name gets a fresh
 * Repo DO (no zombie state).
 *
 * ### Resolving a repo
 * **Example:** Worker-side lookup
 * ```typescript
 * const registry = yield* Registry;
 * const entry = yield* registry.getByName(REGISTRY_DO_NAME).resolve("acme", "web");
 * if (entry === undefined) return yield* new RepoNotFound({ owner: "acme", repo: "web" });
 * ```
 */
import * as Cloudflare from "../Cloudflare/index.ts";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import type { RuntimeContext } from "../RuntimeContext.ts";
import * as Effect from "effect/Effect";
import { RepoAlreadyExists, ValidationError } from "./Api.ts";
import { StoreError } from "./Protocol/Store.ts";
import {
  initRegistrySchema,
  makeSqlClient,
  type RegistryRepoRow,
} from "./Store/Sql.ts";

// ─────────────────────────────────────────────────────────────────────────────
// ULID
// ─────────────────────────────────────────────────────────────────────────────

/** Crockford base32 alphabet used by ULIDs. */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Mints a ULID (48-bit millisecond timestamp + 80 random bits, Crockford
 * base32, 26 chars). Used for repo ids, token ids, and push ids —
 * lexicographically sortable by creation time and safe as an R2 key prefix.
 */
export const ulid = (): Effect.Effect<string> =>
  Effect.sync(() => {
    let time = Date.now();
    const chars = new Array<string>(26);
    // 10 chars of time, most-significant first
    for (let i = 9; i >= 0; i--) {
      chars[i] = CROCKFORD[time % 32]!;
      time = Math.floor(time / 32);
    }
    const rand = crypto.getRandomValues(new Uint8Array(16));
    // 16 chars of randomness, 5 bits each from a fresh random byte
    for (let i = 0; i < 16; i++) {
      chars[10 + i] = CROCKFORD[rand[i]! % 32]!;
    }
    return chars.join("");
  });

// ─────────────────────────────────────────────────────────────────────────────
// Contract
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The singleton Registry instance name: `registry.getByName(REGISTRY_DO_NAME)`.
 */
export const REGISTRY_DO_NAME = "registry" as const;

/**
 * The reserved owner name — `/api/v1/**` must never collide with a repo URL,
 * so the Registry rejects `api` at creation (DESIGN.md §2.2).
 */
export const RESERVED_OWNERS: ReadonlySet<string> = new Set(["api"]);

/** One registry row, as returned over RPC (plain serializable data). */
export interface RegistryEntry {
  readonly owner: string;
  readonly name: string;
  readonly repoId: string;
  readonly description: string | null;
  /** Parent repoId when this repo is a fork, else `null`. */
  readonly forkOf: string | null;
  /** Live forks referencing this repo's R2 prefix. */
  readonly forkCount: number;
  /** Epoch milliseconds. */
  readonly createdAt: number;
  /** Anyone can read/clone without a token (GitHub public-repo model). */
  readonly public: boolean;
  /** Soft-delete marker set while the purge alarm runs, else `null`. */
  readonly deletedAt: number | null;
  /**
   * Denormalised display fields, pushed by the Repo DO on change so
   * `repos.list` renders a page without waking one DO per row
   * (DESIGN.md §15 bottleneck 7). The DO stays the source of truth.
   */
  readonly defaultBranch: string;
  readonly readOnly: boolean;
  readonly status: string;
}

/** Summary fields the Repo DO pushes to the Registry when they change. */
export interface RepoSummary {
  readonly defaultBranch: string;
  readonly readOnly: boolean;
  /** Anyone can read/clone without a token (GitHub public-repo model). */
  readonly public: boolean;
  readonly status: string;
}

/** Input of {@link RegistryShape.createRepo}. */
export interface CreateRepoInput {
  readonly owner: string;
  readonly name: string;
  readonly description?: string | undefined;
  /** Anyone can read/clone without a token when `true`. */
  readonly public?: boolean | undefined;
  /** Parent repoId when creating a fork target row. */
  readonly forkOf?: string | undefined;
}

/** Input of {@link RegistryShape.list}. */
export interface ListReposInput {
  readonly owner?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
  /** Restrict to public repos — the anonymous/non-admin listing. */
  readonly publicOnly?: boolean | undefined;
}

/** Result page of {@link RegistryShape.list}. */
export interface ListReposResult {
  readonly items: ReadonlyArray<RegistryEntry>;
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

/**
 * The Registry DO's typed RPC surface. Note the platform gotcha: no method
 * may be named `delete` (reserved by Cloudflare's RPC stub proxy) — row
 * removal is `removeRow`.
 */
export interface RegistryShape {
  /**
   * Uniqueness-CAS insert of a new repo row; mints the repoId ULID.
   * Rejects reserved owners with {@link ValidationError} and existing
   * `owner/name` rows (including rows still purging) with
   * {@link RepoAlreadyExists}. When `forkOf` is given, the parent's
   * `fork_count` is bumped in the same transaction.
   */
  readonly createRepo: (
    input: CreateRepoInput,
  ) => Effect.Effect<
    RegistryEntry,
    RepoAlreadyExists | ValidationError | StoreError,
    RuntimeContext
  >;
  /** Looks up a live (non-deleted) row, or `undefined`. */
  readonly resolve: (
    owner: string,
    name: string,
  ) => Effect.Effect<RegistryEntry | undefined, StoreError, RuntimeContext>;
  /** Cursor-paginated listing of live rows, optionally filtered by owner. */
  readonly list: (
    input: ListReposInput,
  ) => Effect.Effect<ListReposResult, StoreError, RuntimeContext>;
  /**
   * Records a new fork of `parentRepoId` (`fork_count + 1`). Equivalent to
   * `bumpForkCount(parentRepoId, 1)`; kept as its own verb for call-site
   * clarity.
   */
  readonly recordFork: (
    parentRepoId: string,
  ) => Effect.Effect<number, StoreError, RuntimeContext>;
  /**
   * Adjusts a repo's `fork_count` by `delta` (may be 0 to read) and returns
   * the new value. The delete-purge job polls this: the parent's R2 prefix
   * is retained while the count is positive (DESIGN.md §2.3 Delete).
   */
  readonly bumpForkCount: (
    repoId: string,
    delta: number,
  ) => Effect.Effect<number, StoreError, RuntimeContext>;
  /**
   * Soft-deletes a row (sets `deleted_at`); the name stays reserved until
   * {@link RegistryShape.removeRow} after the purge completes.
   */
  readonly markDeleted: (
    repoId: string,
  ) => Effect.Effect<void, StoreError, RuntimeContext>;
  /**
   * Hard-removes a row after purge — the last step of repo deletion, which
   * frees the `owner/name` for reuse. Also decrements the fork parent's
   * `fork_count` when the removed repo was a fork.
   */
  readonly removeRow: (
    repoId: string,
  ) => Effect.Effect<void, StoreError, RuntimeContext>;
  /**
   * Refreshes the denormalised display fields for a repo. Called by the
   * Repo DO whenever they change (create, metadata update, status
   * transition), so listing never has to consult the DO.
   */
  readonly updateSummary: (
    repoId: string,
    summary: RepoSummary,
  ) => Effect.Effect<void, StoreError, RuntimeContext>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────────────────────────

export const toEntry = (row: RegistryRepoRow): RegistryEntry => ({
  owner: row.owner,
  name: row.name,
  repoId: row.repo_id,
  description: row.description,
  forkOf: row.fork_of,
  forkCount: row.fork_count,
  createdAt: row.created_at,
  deletedAt: row.deleted_at,
  defaultBranch: row.default_branch,
  readOnly: row.read_only === 1,
  public: row.is_public === 1,
  status: row.status,
});

/** Encodes/decodes the opaque list cursor: base64url of `owner\0name`. */
export const encodeCursor = (owner: string, name: string): string =>
  Buffer.from(`${owner}\0${name}`, "utf8").toString("base64url");
export const decodeCursor = (
  cursor: string,
): readonly [owner: string, name: string] | undefined => {
  try {
    const text = Buffer.from(cursor, "base64url").toString("utf8");
    const sep = text.indexOf("\0");
    if (sep === -1) return undefined;
    return [text.slice(0, sep), text.slice(sep + 1)];
  } catch {
    return undefined;
  }
};

/** Default / maximum page size of {@link RegistryShape.list}. */
export const DEFAULT_LIST_LIMIT = 50;

/**
 * The singleton Registry Durable Object class (modular form — the runtime
 * implementation lives in {@link RegistryLive}, provided by `GitWorker`).
 */
export class Registry extends Cloudflare.DurableObject<
  Registry,
  RegistryShape
>()("GitRegistry", {
  // RPC-boundary error revival (see `DurableObjectProps.errors`).
  errors: [RepoAlreadyExists, ValidationError, StoreError],
}) {}

/**
 * `Git.RegistryStore` — the repo *index* as a swappable block: the
 * `owner/name -> repoId` mapping, uniqueness, and listing.
 *
 * The rest of the service depends on this contract, never on a
 * particular backend, so the index can be chosen at assembly:
 *
 * - {@link RegistryDurableObject} — one Durable Object. Zero extra
 *   infrastructure, and the strongest consistency (a single-threaded
 *   `transactionSync` makes create a true CAS). It is also one object
 *   for the whole service, so reads funnel through a single thread in a
 *   single region.
 * - `Git.RegistryD1` — a D1 database. Reads scale out (D1 replicates
 *   them) and `WHERE owner = ?` listing is what a relational store is
 *   for; uniqueness comes from the `PRIMARY KEY (owner, name)` instead
 *   of from single-threading.
 *
 * Both satisfy {@link RegistryShape} exactly, so swapping is one line in
 * the layer graph.
 *
 * @binding
 */
export class RegistryStore extends Context.Service<
  RegistryStore,
  RegistryShape
>()("alchemy/Git/RegistryStore") {}

/**
 * The Registry DO implementation Layer. Provide on the hosting Worker's
 * init effect (`Effect.provide(RegistryLive)`).
 */
export const RegistryLive = Registry.make(
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;

    return Effect.gen(function* () {
      const sql = makeSqlClient(state);
      // Constructor effects cannot fail — schema init failure is a defect.
      yield* initRegistrySchema(sql).pipe(Effect.orDie);

      const shape: RegistryShape = {
        createRepo: Effect.fn(function* (input: CreateRepoInput) {
          const owner = input.owner.toLowerCase();
          const name = input.name.toLowerCase();
          if (RESERVED_OWNERS.has(owner)) {
            return yield* new ValidationError({
              message: `owner name '${owner}' is reserved`,
            });
          }
          const repoId = yield* ulid();
          const createdAt = Date.now();
          // The DO's single-threaded event loop + transactionSync make the
          // exists-check + insert a real CAS.
          return yield* sql.transactionSync<RegistryEntry, RepoAlreadyExists>(
            (raw, rollback) => {
              const existing = raw
                .exec<RegistryRepoRow>(
                  `SELECT * FROM repos WHERE owner = ? AND name = ?`,
                  owner,
                  name,
                )
                .toArray();
              if (existing.length > 0) {
                // Includes soft-deleted rows: the name frees only after purge.
                rollback(new RepoAlreadyExists({ owner, repo: name }));
              }
              raw.exec(
                `INSERT INTO repos (owner, name, repo_id, description, is_public, fork_of, fork_count, created_at, deleted_at)
               VALUES (?, ?, ?, ?, ?, ?, 0, ?, NULL)`,
                owner,
                name,
                repoId,
                input.description ?? null,
                input.public === true ? 1 : 0,
                input.forkOf ?? null,
                createdAt,
              );
              if (input.forkOf !== undefined) {
                raw.exec(
                  `UPDATE repos SET fork_count = fork_count + 1 WHERE repo_id = ?`,
                  input.forkOf,
                );
              }
              return {
                owner,
                name,
                repoId,
                defaultBranch: "main",
                readOnly: false,
                public: input.public === true,
                status: "ready",
                description: input.description ?? null,
                forkOf: input.forkOf ?? null,
                forkCount: 0,
                createdAt,
                deletedAt: null,
              } satisfies RegistryEntry;
            },
          );
        }),

        resolve: Effect.fn(function* (owner: string, name: string) {
          // Soft-deleted rows ARE returned (with `deletedAt` set): the name
          // stays reserved until the purge alarm calls `removeRow`, and the
          // Worker needs to see the in-flight deletion to report
          // `status: "deleting"` on GET (instead of a premature 404 that
          // would race re-creates against the purge).
          const row = yield* sql.first<RegistryRepoRow>(
            `SELECT * FROM repos WHERE owner = ? AND name = ?`,
            owner.toLowerCase(),
            name.toLowerCase(),
          );
          return row === undefined ? undefined : toEntry(row);
        }),

        list: Effect.fn(function* (input: ListReposInput) {
          const limit = Math.max(
            1,
            Math.min(input.limit ?? DEFAULT_LIST_LIMIT, 100),
          );
          const after =
            input.cursor === undefined ? undefined : decodeCursor(input.cursor);
          const conditions: Array<string> = ["deleted_at IS NULL"];
          const bindings: Array<string | number> = [];
          if (input.publicOnly === true) {
            conditions.push("is_public = 1");
          }
          if (input.owner !== undefined) {
            conditions.push("owner = ?");
            bindings.push(input.owner.toLowerCase());
          }
          if (after !== undefined) {
            conditions.push("(owner > ? OR (owner = ? AND name > ?))");
            bindings.push(after[0], after[0], after[1]);
          }
          const rows = yield* sql.all<RegistryRepoRow>(
            `SELECT * FROM repos WHERE ${conditions.join(" AND ")}
             ORDER BY owner, name LIMIT ?`,
            ...bindings,
            limit + 1,
          );
          const hasMore = rows.length > limit;
          const page = hasMore ? rows.slice(0, limit) : rows;
          const last = page[page.length - 1];
          return {
            items: page.map(toEntry),
            nextCursor:
              hasMore && last !== undefined
                ? encodeCursor(last.owner, last.name)
                : null,
            hasMore,
          } satisfies ListReposResult;
        }),

        recordFork: (parentRepoId) => shape.bumpForkCount(parentRepoId, 1),

        bumpForkCount: Effect.fn(function* (repoId: string, delta: number) {
          if (delta !== 0) {
            yield* sql.run(
              `UPDATE repos SET fork_count = MAX(0, fork_count + ?) WHERE repo_id = ?`,
              delta,
              repoId,
            );
            const row = yield* sql.first<{ fork_count: number }>(
              `SELECT fork_count FROM repos WHERE repo_id = ?`,
              repoId,
            );
            return row?.fork_count ?? 0;
          }
          // The read path (delta 0) DERIVES the count from live fork rows
          // rather than the stored column: the purge fork-pin must keep
          // working after the parent's own registry row is removed (the
          // name frees immediately on delete; only the R2 prefix stays
          // pinned while forks reference it), and fork rows keep their
          // `fork_of` pointer until their own purge completes.
          const row = yield* sql.first<{ n: number }>(
            `SELECT COUNT(*) AS n FROM repos WHERE fork_of = ?`,
            repoId,
          );
          return row?.n ?? 0;
        }),

        markDeleted: Effect.fn(function* (repoId: string) {
          yield* sql.run(
            `UPDATE repos SET deleted_at = ? WHERE repo_id = ? AND deleted_at IS NULL`,
            Date.now(),
            repoId,
          );
        }),

        updateSummary: Effect.fn(function* (
          repoId: string,
          summary: RepoSummary,
        ) {
          yield* sql.run(
            `UPDATE repos SET default_branch = ?, read_only = ?, is_public = ?, status = ?
              WHERE repo_id = ?`,
            summary.defaultBranch,
            summary.readOnly ? 1 : 0,
            summary.public ? 1 : 0,
            summary.status,
            repoId,
          );
        }),

        removeRow: Effect.fn(function* (repoId: string) {
          const row = yield* sql.first<RegistryRepoRow>(
            `SELECT * FROM repos WHERE repo_id = ?`,
            repoId,
          );
          if (row === undefined) {
            return; // idempotent — purge re-runs are expected
          }
          yield* sql.run(`DELETE FROM repos WHERE repo_id = ?`, repoId);
          if (row.fork_of !== null) {
            yield* sql.run(
              `UPDATE repos SET fork_count = MAX(0, fork_count - 1) WHERE repo_id = ?`,
              row.fork_of,
            );
          }
        }),
      };

      return shape;
    });
  }),
);

/**
 * {@link RegistryStore} backed by the singleton Registry Durable Object —
 * the default. Registers the DO implementation and resolves the store to
 * its stub, so callers never name the instance.
 *
 * @layer
 * @provides Git.RegistryStore
 */
export const RegistryDurableObject: Layer.Layer<RegistryStore> = Layer.effect(
  RegistryStore,
  Effect.gen(function* () {
    const namespace = yield* Registry;
    // `getByName` must stay LAZY: the layer is built during deploy
    // planning as well as at runtime, and the namespace only resolves to
    // something callable inside a request. Each method therefore takes
    // the stub at call time, exactly as the hand-rolled `registryStub()`
    // did before this contract existed.
    const stub = () => namespace.getByName(REGISTRY_DO_NAME);
    return {
      createRepo: (input) => stub().createRepo(input),
      resolve: (owner, name) => stub().resolve(owner, name),
      list: (input) => stub().list(input),
      recordFork: (parentRepoId) => stub().recordFork(parentRepoId),
      bumpForkCount: (repoId, delta) => stub().bumpForkCount(repoId, delta),
      markDeleted: (repoId) => stub().markDeleted(repoId),
      removeRow: (repoId) => stub().removeRow(repoId),
      updateSummary: (repoId, summary) => stub().updateSummary(repoId, summary),
    } satisfies RegistryShape;
  }),
).pipe(Layer.provide(RegistryLive)) as never;

export default RegistryLive;
