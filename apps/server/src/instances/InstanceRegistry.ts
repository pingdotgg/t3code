/**
 * InstanceRegistry - Cross-process registry of live T3 server instances on one PC.
 *
 * Each running instance announces itself by writing one JSON lock file under a
 * shared `instances/` directory. The directory is derived from the *well-known*
 * default base root (`resolveBaseDir(undefined)` → `~/.t3`) — NOT from the
 * announcing instance's own `baseDir` — so every instance, including those that
 * isolate their state via `--instance <name>` (whose `baseDir` is
 * `~/.t3/instances-data/<name>`), shares a single registry directory.
 *
 * `list()` decodes every lock file and prunes entries whose pid is no longer
 * alive, so the registry is self-healing after a crash or hard kill. Persistence
 * mirrors `serverRuntimeState.ts` (atomic write + `Schema.fromJsonString` decode).
 *
 * Implements session contract C1.
 *
 * @module InstanceRegistry
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import { resolveBaseDir } from "../os-jank.ts";

/** Schema version for the on-disk instance lock file (contract C1). */
export const INSTANCE_RECORD_SCHEMA_VERSION = 1;

/**
 * InstanceRecord - The C1 lock-file shape an instance writes to announce itself.
 */
export const InstanceRecord = Schema.Struct({
  instanceId: Schema.String,
  name: Schema.NullOr(Schema.String),
  pid: Schema.Int,
  port: Schema.Int,
  host: Schema.String,
  baseDir: Schema.String,
  cwd: Schema.String,
  startedAt: Schema.String,
  schemaVersion: Schema.Literal(INSTANCE_RECORD_SCHEMA_VERSION),
});
export type InstanceRecord = typeof InstanceRecord.Type;

const decodeInstanceRecord = Schema.decodeUnknownEffect(Schema.fromJsonString(InstanceRecord));
const encodeInstanceRecord = Schema.encodeEffect(Schema.fromJsonString(InstanceRecord));

const startedAtOrder = Order.mapInput(Order.String, (record: InstanceRecord) => record.startedAt);

/**
 * Returns true when the process for `pid` is still alive.
 *
 * `process.kill(pid, 0)` performs an existence/permission probe without
 * delivering a signal: it throws `ESRCH` when no such process exists (dead) and
 * `EPERM` when the process exists but is owned by another user (alive, but we
 * may not signal it). Any other outcome is treated conservatively as alive so we
 * never prune a live instance by mistake.
 */
export const isPidAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  if (pid === process.pid) {
    return true;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    // ESRCH → no such process (dead). EPERM → exists but not ours (alive).
    return code === "EPERM";
  }
};

export interface InstanceRegistryShape {
  /** Atomically write this instance's lock file. */
  readonly announce: (record: InstanceRecord) => Effect.Effect<void>;
  /** Remove an instance's lock file (no-op if already absent). */
  readonly withdraw: (instanceId: string) => Effect.Effect<void>;
  /** List live instances, pruning dead-pid entries, ordered by start time. */
  readonly list: () => Effect.Effect<ReadonlyArray<InstanceRecord>>;
  /** The shared registry directory used by this layer. */
  readonly registryDir: string;
}

/**
 * InstanceRegistry - Service tag for the live-instance registry.
 */
export class InstanceRegistry extends Context.Service<InstanceRegistry, InstanceRegistryShape>()(
  "t3/instances/InstanceRegistry",
) {}

const lockFileName = (instanceId: string): string => `${encodeURIComponent(instanceId)}.json`;

/**
 * Build an `InstanceRegistryShape` rooted at `registryDir`.
 *
 * `make` is exported (and accepts an explicit root) so tests can target an
 * isolated temp directory; the production `layer` derives the well-known root.
 */
export const make = (
  registryDir: string,
): Effect.Effect<InstanceRegistryShape, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const announce: InstanceRegistryShape["announce"] = (record) =>
      Effect.gen(function* () {
        const encoded = yield* encodeInstanceRecord(record);
        yield* writeFileStringAtomically({
          filePath: path.join(registryDir, lockFileName(record.instanceId)),
          contents: `${encoded}\n`,
        });
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.orDie,
      );

    const withdraw: InstanceRegistryShape["withdraw"] = (instanceId) =>
      fs
        .remove(path.join(registryDir, lockFileName(instanceId)), { force: true })
        .pipe(Effect.ignore({ log: true }));

    const readRecord = (filePath: string): Effect.Effect<InstanceRecord | undefined> =>
      Effect.gen(function* () {
        const raw = yield* fs.readFileString(filePath).pipe(Effect.orElseSucceed(() => ""));
        const trimmed = raw.trim();
        if (trimmed.length === 0) {
          return undefined;
        }
        const decoded = yield* decodeInstanceRecord(trimmed).pipe(Effect.option);
        return Option.getOrUndefined(decoded);
      });

    const list: InstanceRegistryShape["list"] = () =>
      Effect.gen(function* () {
        const dirExists = yield* fs.exists(registryDir).pipe(Effect.orElseSucceed(() => false));
        if (!dirExists) {
          return [] as ReadonlyArray<InstanceRecord>;
        }

        const entries = yield* fs.readDirectory(registryDir).pipe(Effect.orElseSucceed(() => []));
        const lockFiles = entries.filter((entry) => entry.endsWith(".json"));

        const live: Array<InstanceRecord> = [];
        for (const entry of lockFiles) {
          const filePath = path.join(registryDir, entry);
          const record = yield* readRecord(filePath);
          if (record === undefined) {
            // Unreadable/corrupt lock file — drop it so the dir self-heals.
            yield* fs.remove(filePath, { force: true }).pipe(Effect.ignore({ log: true }));
            continue;
          }
          if (isPidAlive(record.pid)) {
            live.push(record);
          } else {
            // Stale entry: the announcing process is gone. Prune on read.
            yield* fs.remove(filePath, { force: true }).pipe(Effect.ignore({ log: true }));
          }
        }

        return live.sort(startedAtOrder) as ReadonlyArray<InstanceRecord>;
      });

    return { announce, withdraw, list, registryDir } satisfies InstanceRegistryShape;
  });

/**
 * Resolve the shared registry directory from the well-known default base root.
 *
 * Always `<resolveBaseDir(undefined)>/instances` (`~/.t3/instances`), regardless
 * of any instance's own `baseDir`, so the registry is shared by all instances.
 */
export const resolveRegistryDir: Effect.Effect<string, never, Path.Path> = Effect.gen(function* () {
  const path = yield* Path.Path;
  const defaultBaseRoot = yield* resolveBaseDir(undefined);
  return path.join(defaultBaseRoot, "instances");
});

/**
 * InstanceRegistryLive - Production layer rooted at the well-known `~/.t3/instances`.
 */
export const layer = Layer.effect(
  InstanceRegistry,
  Effect.gen(function* () {
    const registryDir = yield* resolveRegistryDir;
    return yield* make(registryDir);
  }),
);

/**
 * Build a layer rooted at an explicit directory (used by tests for isolation).
 */
export const layerAt = (registryDir: string) =>
  Layer.effect(InstanceRegistry, make(registryDir));
