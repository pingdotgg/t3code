/**
 * `Git.RegistryD1` — the repo index on a D1 database.
 *
 * An interchangeable implementation of {@link RegistryStore}: same
 * contract as {@link RegistryDurableObject}, different scaling shape.
 * The Durable Object is one single-threaded object in one region for the
 * whole service; D1 replicates reads, and `owner/name` resolution plus
 * `WHERE owner = ?` listing are exactly what a relational store is built
 * for. Writes (create, delete, summary refresh) are rare by comparison.
 *
 * Uniqueness moves with it. The DO gets a compare-and-swap from its own
 * single-threaded `transactionSync`; here it comes from the schema —
 * `PRIMARY KEY (owner, name)` plus an insert guarded by `WHERE NOT
 * EXISTS`, which SQLite evaluates atomically within the statement. A
 * losing racer sees `changes === 0` and reports `RepoAlreadyExists`,
 * with no error-string sniffing.
 *
 * ### Choosing an index
 * **Example:** D1 instead of the default Durable Object
 * ```typescript
 * const RepoIndex = Cloudflare.D1.Database("RepoIndex");
 *
 * const GitLive = Git.ApiLive.pipe(
 *   Layer.provide(Git.ApiHandlersLive),
 *   Layer.provide(Authentication.layer),
 *   Layer.provide(Git.ReposDurableObject),
 *   Layer.provide(Git.RegistryD1(RepoIndex)),
 *   Layer.provide(Git.BlobStoreR2(GitObjects)),
 * );
 * ```
 *
 * @layer
 * @provides Git.RegistryStore
 * @product Git
 */
import type * as runtime from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Cloudflare from "../Cloudflare/index.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { Database } from "../Cloudflare/D1/Database.ts";
import type { QueryDatabaseClient } from "../Cloudflare/D1/QueryDatabase.ts";
import { RepoAlreadyExists, ValidationError } from "./Api.ts";
import { StoreError } from "./Protocol/Store.ts";
import {
  DEFAULT_LIST_LIMIT,
  RegistryStore,
  RESERVED_OWNERS,
  decodeCursor,
  encodeCursor,
  toEntry,
  ulid,
  type CreateRepoInput,
  type ListReposInput,
  type ListReposResult,
  type RegistryEntry,
  type RegistryShape,
  type RepoSummary,
} from "./RegistryObject.ts";
import { REGISTRY_DDL, type RegistryRepoRow } from "./Store/Sql.ts";

/**
 * D1's executors put failures in the defect channel (their error channel
 * is `never`), so every call is wrapped to surface as a typed
 * {@link StoreError} like the rest of the service.
 */
const d1 = <A>(
  what: string,
  effect: Effect.Effect<A, never, RuntimeContext>,
): Effect.Effect<A, StoreError, RuntimeContext> =>
  Effect.catchCause(effect, (cause) =>
    Effect.fail(new StoreError({ reason: `registry ${what}: ${cause}` })),
  );

/**
 * The repo index on D1. The database must already exist; the table is
 * created idempotently on first use from the same DDL the Durable Object
 * applies, so the two backends stay schema-identical.
 */
export const RegistryD1 = (database: Database): Layer.Layer<RegistryStore> =>
  Layer.effect(
    RegistryStore,
    Effect.gen(function* () {
      const db: QueryDatabaseClient =
        yield* Cloudflare.D1.QueryDatabase(database);

      // The DDL is shared with the DO (Store/Sql.ts) — one definition, so
      // the backends can never drift apart.
      const ready = Effect.suspend(() =>
        Effect.forEach(REGISTRY_DDL, (statement) =>
          d1("schema", db.prepare(statement).run()),
        ),
      ).pipe(Effect.asVoid, Effect.cached);
      const schema = yield* ready;

      const rows = <T>(result: runtime.D1Result<T>): ReadonlyArray<T> =>
        (result.results ?? []) as ReadonlyArray<T>;

      const shape: RegistryShape = {
        createRepo: Effect.fn(function* (input: CreateRepoInput) {
          const owner = input.owner.toLowerCase();
          const name = input.name.toLowerCase();
          if (RESERVED_OWNERS.has(owner)) {
            return yield* new ValidationError({
              message: `owner name '${owner}' is reserved`,
            });
          }
          yield* schema;
          const repoId = yield* ulid();
          const createdAt = Date.now();

          // Guarded insert: SQLite evaluates the NOT EXISTS and the write
          // atomically, so this is the CAS the DO gets from its single
          // thread. `changes === 0` means someone already holds the name
          // (a soft-deleted row still does, until purge frees it).
          const inserted = yield* d1(
            "createRepo",
            db
              .prepare(
                `INSERT INTO repos
                   (owner, name, repo_id, description, is_public, fork_of, fork_count, created_at, deleted_at)
                 SELECT ?, ?, ?, ?, ?, ?, 0, ?, NULL
                  WHERE NOT EXISTS (
                    SELECT 1 FROM repos WHERE owner = ? AND name = ?
                  )`,
              )
              .bind(
                owner,
                name,
                repoId,
                input.description ?? null,
                input.public === true ? 1 : 0,
                input.forkOf ?? null,
                createdAt,
                owner,
                name,
              )
              .run(),
          );
          if ((inserted.meta?.changes ?? 0) === 0) {
            return yield* new RepoAlreadyExists({ owner, repo: name });
          }
          if (input.forkOf !== undefined) {
            // Deliberately not batched with the insert: the fork count is
            // only ever READ derived from live `fork_of` rows (see
            // `bumpForkCount` with delta 0), so a crash between the two
            // cannot strand a purge.
            yield* d1(
              "recordFork",
              db
                .prepare(
                  `UPDATE repos SET fork_count = fork_count + 1 WHERE repo_id = ?`,
                )
                .bind(input.forkOf)
                .run(),
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
        }),

        resolve: Effect.fn(function* (owner: string, name: string) {
          yield* schema;
          // Soft-deleted rows ARE returned (with `deletedAt` set) so the
          // Worker can report `status: "deleting"` rather than a 404 that
          // would race a re-create against the purge.
          const row = yield* d1(
            "resolve",
            db
              .prepare(`SELECT * FROM repos WHERE owner = ? AND name = ?`)
              .bind(owner.toLowerCase(), name.toLowerCase())
              .first<RegistryRepoRow>(),
          );
          return row === null ? undefined : toEntry(row);
        }),

        list: Effect.fn(function* (input: ListReposInput) {
          yield* schema;
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
          const page = yield* d1(
            "list",
            db
              .prepare(
                `SELECT * FROM repos WHERE ${conditions.join(" AND ")}
                  ORDER BY owner, name LIMIT ?`,
              )
              .bind(...bindings, limit + 1)
              .all<RegistryRepoRow>(),
          );
          const all = rows(page);
          const hasMore = all.length > limit;
          const items = hasMore ? all.slice(0, limit) : all;
          const last = items[items.length - 1];
          return {
            items: items.map(toEntry),
            nextCursor:
              hasMore && last !== undefined
                ? encodeCursor(last.owner, last.name)
                : null,
            hasMore,
          } satisfies ListReposResult;
        }),

        recordFork: (parentRepoId) => shape.bumpForkCount(parentRepoId, 1),

        bumpForkCount: Effect.fn(function* (repoId: string, delta: number) {
          yield* schema;
          if (delta !== 0) {
            yield* d1(
              "bumpForkCount",
              db
                .prepare(
                  `UPDATE repos SET fork_count = MAX(0, fork_count + ?) WHERE repo_id = ?`,
                )
                .bind(delta, repoId)
                .run(),
            );
            const row = yield* d1(
              "bumpForkCount read",
              db
                .prepare(`SELECT fork_count FROM repos WHERE repo_id = ?`)
                .bind(repoId)
                .first<{ fork_count: number }>(),
            );
            return row?.fork_count ?? 0;
          }
          // Delta 0 DERIVES the count from live fork rows rather than the
          // stored column, so the purge fork-pin keeps working after the
          // parent's own row is removed (matching the DO exactly).
          const row = yield* d1(
            "forkCount",
            db
              .prepare(`SELECT COUNT(*) AS n FROM repos WHERE fork_of = ?`)
              .bind(repoId)
              .first<{ n: number }>(),
          );
          return row?.n ?? 0;
        }),

        markDeleted: Effect.fn(function* (repoId: string) {
          yield* schema;
          yield* d1(
            "markDeleted",
            db
              .prepare(
                `UPDATE repos SET deleted_at = ? WHERE repo_id = ? AND deleted_at IS NULL`,
              )
              .bind(Date.now(), repoId)
              .run(),
          );
        }),

        updateSummary: Effect.fn(function* (
          repoId: string,
          summary: RepoSummary,
        ) {
          yield* schema;
          yield* d1(
            "updateSummary",
            db
              .prepare(
                `UPDATE repos SET default_branch = ?, read_only = ?, is_public = ?, status = ?
                  WHERE repo_id = ?`,
              )
              .bind(
                summary.defaultBranch,
                summary.readOnly ? 1 : 0,
                summary.public ? 1 : 0,
                summary.status,
                repoId,
              )
              .run(),
          );
        }),

        removeRow: Effect.fn(function* (repoId: string) {
          yield* schema;
          const row = yield* d1(
            "removeRow read",
            db
              .prepare(`SELECT * FROM repos WHERE repo_id = ?`)
              .bind(repoId)
              .first<RegistryRepoRow>(),
          );
          if (row === null) {
            return; // idempotent — purge re-runs are expected
          }
          // One batch: the row goes and the fork parent is decremented
          // together, or neither happens.
          const statements = [
            db.prepare(`DELETE FROM repos WHERE repo_id = ?`).bind(repoId),
            ...(row.fork_of !== null
              ? [
                  db
                    .prepare(
                      `UPDATE repos SET fork_count = MAX(0, fork_count - 1) WHERE repo_id = ?`,
                    )
                    .bind(row.fork_of),
                ]
              : []),
          ];
          yield* d1("removeRow", db.batch(statements));
        }),
      };

      return shape;
    }),
  ).pipe(Layer.provide(Cloudflare.D1.QueryDatabaseBinding)) as never;
