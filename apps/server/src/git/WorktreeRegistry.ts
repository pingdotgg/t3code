import { ThreadId, WorktreeBaseProvenance } from "@t3tools/contracts";
import { fromJsonStringPretty, fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import * as ServerConfig from "../config.ts";

export const WorktreeRegistryStatus = Schema.Literals(["active", "thread-deleted"]);
export type WorktreeRegistryStatus = typeof WorktreeRegistryStatus.Type;

/**
 * One record per worktree this server created for a thread. The registry is
 * the durable worktree ↔ thread association: attribution never depends on
 * scanning paths or parsing branch names, which makes lifecycle/GC tooling
 * cheap to build later.
 */
export const WorktreeRegistryRecord = Schema.Struct({
  threadId: ThreadId,
  worktreePath: Schema.String,
  branch: Schema.String,
  projectCwd: Schema.String,
  baseRefName: Schema.NullOr(Schema.String),
  baseCommitSha: Schema.NullOr(Schema.String),
  baseProvenance: Schema.NullOr(WorktreeBaseProvenance),
  createdAt: Schema.String,
  status: WorktreeRegistryStatus,
});
export type WorktreeRegistryRecord = typeof WorktreeRegistryRecord.Type;

const WorktreeRegistryFile = Schema.Struct({
  version: Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(1))),
  worktrees: Schema.Array(WorktreeRegistryRecord).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});
type WorktreeRegistryFile = typeof WorktreeRegistryFile.Type;

const decodeRegistryExit = Schema.decodeUnknownExit(fromLenientJson(WorktreeRegistryFile));
const encodeRegistryJson = Schema.encodeEffect(fromJsonStringPretty(WorktreeRegistryFile));

const EMPTY_REGISTRY: WorktreeRegistryFile = { version: 1, worktrees: [] };

export class WorktreeRegistry extends Context.Service<
  WorktreeRegistry,
  {
    /** Record (or refresh) the worktree created for a thread. Never fails. */
    readonly register: (record: Omit<WorktreeRegistryRecord, "status">) => Effect.Effect<void>;
    /** Mark all records for a thread as belonging to a deleted thread. Never fails. */
    readonly markThreadDeleted: (threadId: ThreadId) => Effect.Effect<void>;
    /** Remove records whose worktree path was removed from disk. Never fails. */
    readonly unregisterPath: (worktreePath: string) => Effect.Effect<void>;
    readonly list: Effect.Effect<ReadonlyArray<WorktreeRegistryRecord>>;
  }
>()("t3/git/WorktreeRegistry") {}

export const make = Effect.gen(function* () {
  const { worktreeRegistryPath } = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const writeSemaphore = yield* Semaphore.make(1);
  const loadedRef = yield* Ref.make<WorktreeRegistryFile | null>(null);

  const loadFromDisk = Effect.gen(function* () {
    const exists = yield* fs.exists(worktreeRegistryPath);
    if (!exists) {
      return EMPTY_REGISTRY;
    }
    const raw = yield* fs.readFileString(worktreeRegistryPath);
    const decoded = decodeRegistryExit(raw);
    if (decoded._tag === "Failure") {
      yield* Effect.logWarning("failed to parse worktree registry, starting fresh", {
        path: worktreeRegistryPath,
      });
      return EMPTY_REGISTRY;
    }
    return decoded.value;
  });

  // All reads and writes take the semaphore so a first-access disk load can
  // never overwrite in-memory state that a concurrent mutation just wrote.
  const getRegistryLocked = Effect.gen(function* () {
    const loaded = yield* Ref.get(loadedRef);
    if (loaded !== null) {
      return loaded;
    }
    const fromDisk = yield* loadFromDisk;
    yield* Ref.set(loadedRef, fromDisk);
    return fromDisk;
  });

  const getRegistry = Semaphore.withPermit(writeSemaphore)(getRegistryLocked);

  const mutate = (
    update: (current: WorktreeRegistryFile) => WorktreeRegistryFile,
  ): Effect.Effect<void> =>
    Semaphore.withPermit(writeSemaphore)(
      Effect.gen(function* () {
        const current = yield* getRegistryLocked;
        const next = update(current);
        const contents = yield* encodeRegistryJson(next);
        yield* writeFileStringAtomically({
          filePath: worktreeRegistryPath,
          contents,
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        );
        // Memory reflects disk only after the persist succeeds, so `list`
        // never reports an association that was never durably recorded.
        yield* Ref.set(loadedRef, next);
      }),
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("failed to persist worktree registry", { cause }),
      ),
      Effect.asVoid,
    );

  return WorktreeRegistry.of({
    register: (record) =>
      mutate((current) => ({
        ...current,
        worktrees: [
          ...current.worktrees.filter((entry) => entry.worktreePath !== record.worktreePath),
          { ...record, status: "active" },
        ],
      })),
    markThreadDeleted: (threadId) =>
      mutate((current) => ({
        ...current,
        worktrees: current.worktrees.map((entry) =>
          entry.threadId === threadId ? { ...entry, status: "thread-deleted" as const } : entry,
        ),
      })),
    unregisterPath: (worktreePath) =>
      mutate((current) => ({
        ...current,
        worktrees: current.worktrees.filter((entry) => entry.worktreePath !== worktreePath),
      })),
    list: getRegistry.pipe(
      Effect.map((registry) => registry.worktrees),
      Effect.orElseSucceed(() => []),
    ),
  });
});

export const layer = Layer.effect(WorktreeRegistry, make);
