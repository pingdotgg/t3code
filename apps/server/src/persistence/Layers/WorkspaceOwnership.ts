import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Effect, Exit, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { canonicalizeWorktreePath, resolveGitWorktreeRoot } from "../../git/worktreePaths.ts";
import { runProcess } from "../../processRunner.ts";
import type { WorkspaceBinding } from "@t3tools/contracts";
import {
  WorkspaceOwnership,
  WorkspaceOwnershipConflict,
  WorkspaceOwnershipRepository,
  WorkspaceOwnershipRepositoryError,
  WorkspaceOwnershipStale,
  type WorkspaceOwnershipRepositoryShape,
} from "../Services/WorkspaceOwnership.ts";

const canonicalCheckoutIdentity = (worktreePath: string) =>
  Effect.tryPromise({
    try: async () => {
      const canonical = await canonicalizeWorktreePath(worktreePath);
      return (await resolveGitWorktreeRoot(canonical)) ?? canonical;
    },
    catch: (cause) => new WorkspaceOwnershipRepositoryError({ cause }),
  });

type FilesystemOwnershipState = {
  readonly canonicalPath: string;
  readonly worktreePath: string;
  readonly ownerThreadId: string | null;
  readonly branch: string | null;
  readonly generation: number;
  readonly attemptId: string | null;
};

const filesystemOwnershipPathsForRegistry = (canonicalPath: string, registryDir: string) => {
  const key = createHash("sha256").update(canonicalPath).digest("hex");
  return {
    registryDir,
    statePath: path.join(registryDir, `${key}.json`),
    mutexPath: path.join(registryDir, `${key}.mutex`),
  };
};

const filesystemOwnershipStatePath = (canonicalPath: string) =>
  Effect.tryPromise({
    try: async () => {
      const commonDirResult = await runProcess(
        "git",
        ["-C", canonicalPath, "rev-parse", "--git-common-dir"],
        {
          allowNonZeroExit: true,
          maxBufferBytes: 16 * 1024,
          timeoutMs: 5_000,
        },
      );
      const commonDir =
        commonDirResult.code === 0
          ? await canonicalizeWorktreePath(
              path.resolve(canonicalPath, commonDirResult.stdout.trim()),
            )
          : path.dirname(canonicalPath);
      const registryDir = path.join(commonDir, "t3-workspace-ownership");
      await mkdir(registryDir, { recursive: true });
      return filesystemOwnershipPathsForRegistry(canonicalPath, registryDir);
    },
    catch: (cause) => new WorkspaceOwnershipRepositoryError({ cause }),
  });

const withFilesystemOwnershipLock = <A>(
  paths: { readonly statePath: string; readonly mutexPath: string },
  effect: (state: FilesystemOwnershipState | null) => Promise<{
    readonly state: FilesystemOwnershipState;
    readonly value: A;
  }>,
) =>
  Effect.tryPromise({
    try: async () => {
      const lockStaleAfterMs = 30_000;
      const lockOwnerPath = path.join(paths.mutexPath, "owner.json");
      const isProcessAlive = (pid: number) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch (error) {
          return (error as NodeJS.ErrnoException).code === "EPERM";
        }
      };
      const reclaimStaleLock = async () => {
        try {
          const lockStat = await stat(paths.mutexPath);
          if (Date.now() - lockStat.mtimeMs < lockStaleAfterMs) return false;
          try {
            const owner = JSON.parse(await readFile(lockOwnerPath, "utf8")) as {
              readonly pid?: number;
            };
            if (typeof owner.pid === "number" && isProcessAlive(owner.pid)) return false;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
              throw error;
            }
          }
          await rm(paths.mutexPath, { recursive: true, force: true });
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
          throw error;
        }
      };
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
          await mkdir(paths.mutexPath);
          await writeFile(
            lockOwnerPath,
            JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }),
            { mode: 0o600 },
          );
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt === 99) {
            throw error;
          }
          if (await reclaimStaleLock()) continue;
          await sleep(10);
        }
      }
      try {
        let state: FilesystemOwnershipState | null = null;
        try {
          state = JSON.parse(await readFile(paths.statePath, "utf8")) as FilesystemOwnershipState;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        const result = await effect(state);
        await writeFile(paths.statePath, JSON.stringify(result.state), { mode: 0o600 });
        return result.value;
      } finally {
        await rm(paths.mutexPath, { recursive: true, force: true });
      }
    },
    catch: (cause) => new WorkspaceOwnershipRepositoryError({ cause }),
  });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const getRow = (canonicalPath: string) =>
    sql<{
      readonly canonical_path: string;
      readonly worktree_path: string;
      readonly filesystem_registry_dir: string | null;
      readonly owner_thread_id: string;
      readonly branch: string | null;
      readonly generation: number;
      readonly command_id: string | null;
      readonly claimed_at: string;
      readonly updated_at: string;
    }>`
      SELECT
        canonical_path,
        worktree_path,
        owner_thread_id,
        branch,
        generation,
        command_id,
        claimed_at,
        updated_at
      FROM workspace_ownership
      WHERE canonical_path = ${canonicalPath}
    `;

  const claim: WorkspaceOwnershipRepositoryShape["claim"] = (input) =>
    Effect.gen(function* () {
      const canonicalWorktreePath = yield* Effect.promise(() =>
        canonicalizeWorktreePath(input.worktreePath),
      );
      const canonicalPath = yield* canonicalCheckoutIdentity(canonicalWorktreePath);
      const filesystemPaths = yield* filesystemOwnershipStatePath(canonicalPath);
      // Unique per-attempt token. The filesystem lock is released before the
      // SQLite transaction runs, and same-thread claims preserve the
      // generation, so concurrent reentrant claims can share one generation.
      // Compensation must only clear state this attempt wrote.
      const attemptId = randomUUID();
      const coOwnerThreadIds = new Set<string>(input.coOwnerThreadIds ?? []);
      // Snapshot of the ledger entry before this attempt overwrote it. The
      // filesystem write below is not transactional, so compensation restores
      // this snapshot instead of nulling the entry: a failed reentrant claim
      // must not destroy the successful claim it overwrote.
      let previousFilesystemState: FilesystemOwnershipState | null = null;
      const filesystemBinding = yield* withFilesystemOwnershipLock(
        filesystemPaths,
        async (state) => {
          if (
            state?.ownerThreadId &&
            state.ownerThreadId !== input.threadId &&
            !coOwnerThreadIds.has(state.ownerThreadId)
          ) {
            throw new WorkspaceOwnershipConflict({
              canonicalPath,
              ownerThreadId: state.ownerThreadId,
              requestedByThreadId: input.threadId,
            });
          }
          previousFilesystemState = state;
          const generation =
            state?.ownerThreadId === input.threadId
              ? state.generation
              : (state?.generation ?? 0) + 1;
          return {
            state: {
              canonicalPath,
              worktreePath: canonicalWorktreePath,
              ownerThreadId: input.threadId,
              branch: input.branch,
              generation,
              attemptId,
            },
            value: {
              canonicalPath,
              worktreePath: canonicalWorktreePath,
              branch: input.branch,
              generation,
            } satisfies WorkspaceBinding,
          };
        },
      );
      const compensateClaim = Effect.gen(function* () {
        yield* withFilesystemOwnershipLock(filesystemPaths, async (state) => {
          if (
            state?.ownerThreadId === input.threadId &&
            state.generation === filesystemBinding.generation &&
            state.attemptId === attemptId
          ) {
            return {
              state: previousFilesystemState ?? {
                ...state,
                ownerThreadId: null,
                branch: null,
                attemptId: null,
              },
              value: undefined,
            };
          }
          return {
            state: state ?? {
              ...filesystemBinding,
              ownerThreadId: null,
              attemptId: null,
            },
            value: undefined,
          };
        });
        yield* sql`
          DELETE FROM workspace_ownership
          WHERE canonical_path = ${canonicalPath}
            AND owner_thread_id = ${input.threadId}
            AND generation = ${filesystemBinding.generation}
            AND attempt_id = ${attemptId}
        `;
      });
      const claimResult = yield* Effect.exit(
        sql.withTransaction(
          Effect.gen(function* () {
            const existing = yield* getRow(canonicalPath);
            if (
              existing.length > 0 &&
              existing[0]!.owner_thread_id !== input.threadId &&
              !coOwnerThreadIds.has(existing[0]!.owner_thread_id)
            ) {
              return yield* Effect.fail(
                new WorkspaceOwnershipConflict({
                  canonicalPath,
                  ownerThreadId: existing[0]!.owner_thread_id,
                  requestedByThreadId: input.threadId,
                }),
              );
            }
            const nextGeneration = filesystemBinding.generation;
            yield* sql`
            INSERT INTO workspace_ownership (
              canonical_path, worktree_path, owner_thread_id, branch,
              generation, command_id, attempt_id, filesystem_registry_dir,
              claimed_at, updated_at
            ) VALUES (
              ${canonicalPath},
              ${canonicalWorktreePath},
              ${input.threadId},
              ${input.branch},
              ${nextGeneration},
              ${input.commandId},
              ${attemptId},
              ${filesystemPaths.registryDir},
              ${input.now},
              ${input.now}
            )
            ON CONFLICT (canonical_path) DO UPDATE SET
              -- Reaching this clause means the previous owner was either this
              -- thread or a declared co-owner, so the row must follow the
              -- filesystem ledger. Leaving owner_thread_id stale makes
              -- assertOwned reject the very binding claim just returned.
              owner_thread_id = excluded.owner_thread_id,
              worktree_path = excluded.worktree_path,
              branch = excluded.branch,
              generation = excluded.generation,
              command_id = excluded.command_id,
              attempt_id = excluded.attempt_id,
              filesystem_registry_dir = excluded.filesystem_registry_dir,
              updated_at = excluded.updated_at
          `;
            return yield* getRow(canonicalPath);
          }),
        ),
      );
      if (Exit.isFailure(claimResult)) {
        const compensationResult = yield* Effect.exit(compensateClaim);
        if (Exit.isFailure(compensationResult)) {
          return yield* new WorkspaceOwnershipRepositoryError({
            cause: { claimError: claimResult.cause, compensationError: compensationResult.cause },
          });
        }
        return yield* Effect.failCause(claimResult.cause);
      }
      const rows = claimResult.value;
      const row = rows[0];
      if (!row)
        return yield* Effect.fail(
          new WorkspaceOwnershipRepositoryError({ cause: "claim did not persist" }),
        );
      return {
        canonicalPath: row.canonical_path,
        worktreePath: row.worktree_path,
        branch: row.branch,
        generation: filesystemBinding.generation,
      } satisfies WorkspaceBinding;
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof WorkspaceOwnershipConflict
          ? cause
          : cause instanceof WorkspaceOwnershipRepositoryError &&
              cause.cause instanceof WorkspaceOwnershipConflict
            ? cause.cause
            : new WorkspaceOwnershipRepositoryError({ cause }),
      ),
    );

  const assertOwned: WorkspaceOwnershipRepositoryShape["assertOwned"] = (binding, threadId) =>
    Effect.gen(function* () {
      const canonicalPath = yield* canonicalCheckoutIdentity(binding.worktreePath);
      const filesystemPaths = yield* filesystemOwnershipStatePath(canonicalPath);
      const filesystemState = yield* withFilesystemOwnershipLock(
        filesystemPaths,
        async (state) => ({
          state: state ?? {
            canonicalPath,
            worktreePath: binding.worktreePath,
            ownerThreadId: null,
            branch: binding.branch,
            generation: binding.generation,
            attemptId: null,
          },
          value: state,
        }),
      );
      const rows = yield* getRow(canonicalPath);
      const row = rows[0];
      if (
        !filesystemState ||
        filesystemState.ownerThreadId !== threadId ||
        filesystemState.generation !== binding.generation ||
        !row ||
        row.owner_thread_id !== threadId ||
        row.generation !== binding.generation ||
        row.canonical_path !== binding.canonicalPath
      ) {
        return yield* Effect.fail(
          new WorkspaceOwnershipStale({ binding, requestedByThreadId: threadId }),
        );
      }
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof WorkspaceOwnershipStale
          ? cause
          : new WorkspaceOwnershipRepositoryError({ cause }),
      ),
    );

  const release: WorkspaceOwnershipRepositoryShape["release"] = (threadId, canonicalPath) =>
    Effect.gen(function* () {
      const rows = yield* sql<{
        readonly canonical_path: string;
        readonly worktree_path: string;
        readonly filesystem_registry_dir: string | null;
      }>`
        SELECT canonical_path, worktree_path, filesystem_registry_dir
        FROM workspace_ownership
        WHERE owner_thread_id = ${threadId}
        ${canonicalPath ? sql`AND canonical_path = ${canonicalPath}` : sql``}
      `;
      const clearedPaths = new Set<string>();
      for (const row of rows) {
        const filesystemPaths =
          row.filesystem_registry_dir === null
            ? yield* filesystemOwnershipStatePath(row.canonical_path)
            : filesystemOwnershipPathsForRegistry(row.canonical_path, row.filesystem_registry_dir);
        yield* withFilesystemOwnershipLock(filesystemPaths, async (state) => {
          if (state !== null && state.ownerThreadId !== null && state.ownerThreadId !== threadId) {
            throw new Error(`workspace ownership changed for ${row.canonical_path}`);
          }
          return {
            state: state
              ? { ...state, ownerThreadId: null }
              : {
                  canonicalPath: row.canonical_path,
                  worktreePath: row.worktree_path,
                  ownerThreadId: null,
                  branch: null,
                  generation: 0,
                  attemptId: null,
                },
            value: undefined,
          };
        });
        clearedPaths.add(row.canonical_path);
      }
      if (canonicalPath !== undefined && !clearedPaths.has(canonicalPath)) {
        // The database row can go missing after a partial failure or a
        // database restoration while the filesystem ledger still names this
        // thread. Inspect the ledger for the supplied path independently of
        // the SQL result so a leaked claim cannot block the worktree forever.
        // The ledger is keyed by Git top-level path, so also check the
        // containing checkout root when a subdirectory was supplied.
        const candidates = yield* Effect.promise(async () => {
          try {
            const root = await resolveGitWorktreeRoot(canonicalPath);
            return root !== null && root !== canonicalPath
              ? [canonicalPath, root]
              : [canonicalPath];
          } catch {
            return [canonicalPath];
          }
        }).pipe(Effect.catch(() => Effect.succeed([canonicalPath] as string[])));
        for (const candidate of candidates) {
          if (clearedPaths.has(candidate)) continue;
          const fallbackPaths = yield* filesystemOwnershipStatePath(candidate).pipe(
            Effect.catch(() => Effect.succeed(null)),
          );
          if (fallbackPaths === null) continue;
          const wasOwned = yield* withFilesystemOwnershipLock(fallbackPaths, async (state) => {
            if (state?.ownerThreadId === threadId) {
              return {
                state: { ...state, ownerThreadId: null, branch: null },
                value: true,
              };
            }
            return {
              state: state ?? {
                canonicalPath: candidate,
                worktreePath: candidate,
                ownerThreadId: null,
                branch: null,
                generation: 0,
                attemptId: null,
              },
              value: false,
            };
          }).pipe(Effect.catch(() => Effect.succeed(false as boolean)));
          if (wasOwned) {
            clearedPaths.add(candidate);
          }
        }
      }
      yield* canonicalPath
        ? sql`DELETE FROM workspace_ownership WHERE owner_thread_id = ${threadId} AND canonical_path = ${canonicalPath}`
        : sql`DELETE FROM workspace_ownership WHERE owner_thread_id = ${threadId}`;
    }).pipe(Effect.mapError((cause) => new WorkspaceOwnershipRepositoryError({ cause })));

  const getByThreadId: WorkspaceOwnershipRepositoryShape["getByThreadId"] = (threadId) =>
    sql`
      SELECT
        canonical_path AS "canonicalPath",
        worktree_path AS "worktreePath",
        owner_thread_id AS "ownerThreadId",
        branch,
        generation,
        command_id AS "commandId",
        claimed_at AS "claimedAt",
        updated_at AS "updatedAt"
      FROM workspace_ownership
      WHERE owner_thread_id = ${threadId}
      ORDER BY canonical_path
    `.pipe(
      Effect.flatMap((rows) => Effect.succeed(rows as ReadonlyArray<WorkspaceOwnership>)),
      Effect.mapError((cause) => new WorkspaceOwnershipRepositoryError({ cause })),
    );

  return WorkspaceOwnershipRepository.of({
    claim,
    assertOwned,
    release,
    getByThreadId,
  });
});

export const WorkspaceOwnershipRepositoryLive = Layer.effect(WorkspaceOwnershipRepository, make);
