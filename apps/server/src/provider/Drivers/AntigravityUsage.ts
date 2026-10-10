/**
 * AntigravityUsage - Antigravity's usage history as a usage source.
 *
 * Antigravity keeps conversations in SQLite databases under its data
 * directories and each instance's profile. Parsed databases are reused while a
 * database and its WAL keep the same `(size, mtime, ctime)`, so a warm scan
 * decodes only what changed. They persist in the server's state directory, so
 * an unchanged history is not decoded again after a restart.
 *
 * @module provider/Drivers/AntigravityUsage
 */

import { type AntigravitySettings, UsageReadError } from "@t3tools/contracts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import type {
  ProviderUsageInstance,
  ProviderUsageReader,
  ProviderUsageScan,
} from "@t3tools/provider-core/server/usage";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { resolveAntigravityInstanceDirectories } from "../antigravityAuthSupport.ts";
import {
  ANTIGRAVITY_USAGE_CACHE_FILE_NAME,
  decodeAntigravityUsageCache,
  makeAntigravityUsageCache,
  makeAntigravityUsageCacheWriter,
  readAntigravityUsage,
} from "./antigravityUsageReader.ts";

/** The cache file is narrowed by hand in `antigravityUsageReader`, so JSON is enough here. */
const decodeCacheFile = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Unknown as unknown as Schema.Codec<unknown>),
);

export class AntigravityUsage extends Context.Service<
  AntigravityUsage,
  {
    /** Every Antigravity store: the data directories and each configured instance's profile. */
    readonly scan: (input: {
      readonly instances: ReadonlyArray<ProviderUsageInstance<AntigravitySettings>>;
      readonly windowStartMs: number;
    }) => Effect.Effect<ReadonlyArray<ProviderUsageScan>, UsageReadError>;
    /** Waits for every cache write scheduled so far, as a restart would need. */
    readonly awaitPersisted: Effect.Effect<void>;
  }
>()("t3/provider/Drivers/AntigravityUsage") {}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const host = yield* ProviderHost.ProviderHost;
  const hostEnvironment = yield* HostProcess.Environment;
  const cache = makeAntigravityUsageCache();
  const cachePath = path.join(host.paths.stateDir, ANTIGRAVITY_USAGE_CACHE_FILE_NAME);
  const writeCache = makeAntigravityUsageCacheWriter();
  let cacheDirty = false;

  /** Loads the saved cache once; concurrent first scans await the same load. */
  const ensureLoaded = yield* Effect.cached(
    fileSystem.readFileString(cachePath).pipe(
      Effect.flatMap((raw) => decodeCacheFile(raw)),
      Effect.catchCause(() => Effect.succeed(null)),
      Effect.map((document) => {
        for (const [key, entry] of decodeAntigravityUsageCache(document)) cache.set(key, entry);
      }),
    ),
  );

  // Serialized so an older snapshot never lands after a newer one. The dirty
  // flag is cleared before encoding, so a change while the write is in flight
  // marks it dirty again; a failed write restores it so the next persist retries.
  const persistLock = yield* Semaphore.make(1);
  const persist = Effect.gen(function* () {
    if (!cacheDirty) return;
    cacheDirty = false;
    yield* Effect.sync(() => writeCache(cache)).pipe(
      Effect.flatMap((contents) => writeFileStringAtomically({ filePath: cachePath, contents })),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.catchCause(() =>
        Effect.sync(() => {
          cacheDirty = true;
        }),
      ),
    );
  }).pipe(persistLock.withPermit, Effect.withSpan("AntigravityUsage.persist"));

  const pendingPersists = new Set<Fiber.Fiber<void>>();
  /** Writes the cache in the background, after the scan that changed it answers. */
  const schedulePersist = Effect.forkDetach(persist).pipe(
    Effect.map((fiber) => {
      pendingPersists.add(fiber);
      fiber.addObserver(() => pendingPersists.delete(fiber));
    }),
  );
  const awaitPersisted = Effect.suspend(() => Fiber.awaitAll([...pendingPersists])).pipe(
    Effect.asVoid,
  );
  // A write still running at shutdown finishes first, so the next start keeps it.
  yield* Effect.addFinalizer(() => awaitPersisted);

  /** `ANTIGRAVITY_DATA_DIR` (comma-separated) or the defaults, canonicalized. */
  const dataRoots = Effect.gen(function* () {
    const home = yield* HostProcess.HomeDirectory;
    const configured = hostEnvironment["ANTIGRAVITY_DATA_DIR"]
      ?.split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const defaults = [
      ...["antigravity", "antigravity-cli", "antigravity-ide", "antigravity-backup"].map((name) =>
        path.join(home, ".gemini", name),
      ),
      path.join(home, ".config", "antigravity"),
    ];
    const canonical = new Set<string>();
    for (const root of configured?.length ? configured : defaults) {
      const resolved = path.resolve(expandHomePath(root, home));
      canonical.add(
        yield* fileSystem.realPath(resolved).pipe(Effect.orElseSucceed(() => resolved)),
      );
    }
    return [...canonical];
  });

  const scan: AntigravityUsage["Service"]["scan"] = Effect.fn("AntigravityUsage.scan")(function* ({
    instances,
    windowStartMs,
  }) {
    yield* ensureLoaded;
    const roots = yield* dataRoots;
    // Only configured instances have a profile; the implicit default never ran.
    for (const { instanceId } of instances.filter((instance) => instance.configured)) {
      const directories = yield* resolveAntigravityInstanceDirectories(
        host.paths.stateDir,
        instanceId,
      ).pipe(
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(Path.Path, path),
        Effect.mapError(
          (cause) =>
            new UsageReadError({
              reason: "scanFailed",
              detail: "Antigravity profile directory could not be resolved.",
              cause,
            }),
        ),
      );
      roots.push(path.join(directories.profile, "antigravity-acp"));
    }
    const conversationDirs = new Set<string>();
    for (const root of roots) {
      const resolvedRoot = yield* fileSystem.realPath(root).pipe(Effect.orElseSucceed(() => root));
      const nested = path.join(resolvedRoot, "conversations");
      const dir = (yield* fileSystem
        .exists(nested)
        .pipe(Effect.catchCause(() => Effect.succeed(false))))
        ? nested
        : resolvedRoot;
      conversationDirs.add(yield* fileSystem.realPath(dir).pipe(Effect.orElseSucceed(() => dir)));
    }
    const result = yield* readAntigravityUsage([...conversationDirs], windowStartMs, cache).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );
    // Also after an unchanged scan, so a failed write is retried.
    if (result.cacheChanged) cacheDirty = true;
    if (cacheDirty) yield* schedulePersist;
    const scanned: ProviderUsageScan[] = [];
    for (const dir of conversationDirs) {
      const exists = yield* fileSystem
        .exists(dir)
        .pipe(Effect.catchCause(() => Effect.succeed(false)));
      const failed = result.errors.some(
        (error) => error === dir || error.startsWith(`${dir}${path.sep}`),
      );
      scanned.push({
        dir,
        files: !exists && !failed ? null : result.files.filter((file) => file.root === dir),
        status: failed ? "partial" : "ok",
        ...(failed ? { message: "Some Antigravity history could not be read." } : {}),
      });
    }
    return scanned;
  });

  return AntigravityUsage.of({ scan, awaitPersisted });
});

export const layer = Layer.effect(AntigravityUsage, make);

export const antigravityUsageReader: ProviderUsageReader<AntigravitySettings, AntigravityUsage> = {
  kind: "scan",
  provider: "antigravity",
  scan: ({ instances, windowStartMs }) =>
    AntigravityUsage.pipe(Effect.flatMap((usage) => usage.scan({ instances, windowStartMs }))),
};
