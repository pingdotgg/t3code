import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import type { Done } from "effect/Cause";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Paths from "../../internal/Paths.ts";
import * as Registry from "../../registry/Registry.ts";
import {
  resolvedTargetKey,
  type RegistryEntry,
  type ResolvedTarget,
  type ResolvedTargetMap,
  type Subscriber,
} from "../../registry/RegistryTypes.shared.ts";
import { configProvider, waitForRegistryEntry } from "../helpers/runtime.ts";

// The `fileSystemSupportsWatcher: true` variant exercises `fs.watch`, which on
// Windows can abort the process with a libuv assertion
// (`fs-event.c: !_wcsnicmp(filename, dir, dirlen)`). The runtime never enables
// the watcher on Windows (it falls back to polling), so there is nothing to
// test there — and forcing it would crash the whole vitest worker fork.
const watcherModes = process.platform === "win32" ? [false] : [true, false];

describe.each(watcherModes)(
  "Registry (fileSystemSupportsWatcher: %s)",
  (fileSystemSupportsWatcher) => {
    const services = Registry.RegistryLive.pipe(
      Layer.provideMerge(Paths.PathsLive),
      Layer.provide(configProvider({ fileSystemSupportsWatcher })),
      Layer.provideMerge(NodeServices.layer),
    );

    const makeTestData = Effect.fn(function* (id: string) {
      const path = yield* Path.Path;
      const directory = yield* Paths.state("alchemy", "registry");
      const scriptName = `test-worker-${fileSystemSupportsWatcher ? "watcher" : "polling"}-${id}`;
      return {
        entryPath: path.join(directory, `${scriptName}.json`),
        registryEntry: registryEntry(scriptName),
        subscriberEntry: subscriberEntry(scriptName),
        registryServiceMap: registryServiceMap(scriptName),
      };
    });

    it.live("register writes a worker definition and read returns it", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const registry = yield* Registry.Registry;

        const {
          entryPath,
          subscriberEntry,
          registryEntry,
          registryServiceMap,
        } = yield* makeTestData("1");

        const scope = yield* Scope.make();
        yield* registry.write(registryEntry).pipe(Scope.provide(scope));

        yield* waitForRegistryEntry(subscriberEntry, { toBeDefined: true });
        expect(yield* fs.exists(entryPath)).toBe(true);
        const mapNonEmpty = yield* registry.read([subscriberEntry]);
        expect(mapNonEmpty).toEqual(registryServiceMap);

        yield* Scope.close(scope, Exit.void);
        yield* waitForRegistryEntry(subscriberEntry, { toBeDefined: false });

        expect(yield* fs.exists(entryPath)).toBe(false);
        const mapEmpty = yield* registry.read([subscriberEntry]);
        expect(mapEmpty).toEqual({});
      }).pipe(Effect.provide(services)),
    );

    it.live("read returns an empty array when the directory is empty", () =>
      Effect.gen(function* () {
        const registry = yield* Registry.Registry;
        const { subscriberEntry } = yield* makeTestData("2");
        expect(yield* registry.read([subscriberEntry])).toEqual({});
      }).pipe(Effect.provide(services)),
    );

    // Make-before-break handoff: a replacement instance re-registers under
    // the same script name before the old instance's scope closes. The old
    // instance's unregister finalizer must not delete the replacement's
    // registration — removal is owner-aware (only removes the file while it
    // still holds that write's content).
    it.live(
      "unregistering a superseded entry keeps the replacement registration",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const registry = yield* Registry.Registry;
          const { entryPath, registryEntry } = yield* makeTestData("7");
          const replacementEntry: RegistryEntry = {
            ...registryEntry,
            debugPortAddress: "127.0.0.1:23456",
          };

          const oldScope = yield* Scope.make();
          yield* registry.write(registryEntry).pipe(Scope.provide(oldScope));

          const replacementScope = yield* Scope.make();
          yield* registry
            .write(replacementEntry)
            .pipe(Scope.provide(replacementScope));

          // Closing the superseded instance's scope must not delete the file —
          // it now belongs to the replacement.
          yield* Scope.close(oldScope, Exit.void);
          expect(yield* fs.exists(entryPath)).toBe(true);
          expect(JSON.parse(yield* fs.readFileString(entryPath))).toEqual(
            replacementEntry,
          );

          // Closing the replacement's own scope removes it.
          yield* Scope.close(replacementScope, Exit.void);
          expect(yield* fs.exists(entryPath)).toBe(false);
        }).pipe(Effect.provide(services)),
    );

    it.live("read skips entries that don't match the subscriber", () =>
      Effect.gen(function* () {
        const registry = yield* Registry.Registry;
        const testData = yield* makeTestData("3a");
        yield* registry.write(testData.registryEntry);
        yield* waitForRegistryEntry(testData.subscriberEntry, {
          toBeDefined: true,
        });
        expect(yield* registry.read([subscriberEntry("3b")])).toEqual({});
      }).pipe(Effect.provide(services)),
    );

    it.live("read skips definitions older than the staleness threshold", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const registry = yield* Registry.Registry;
        const {
          entryPath,
          subscriberEntry,
          registryServiceMap,
          registryEntry,
        } = yield* makeTestData("4");

        yield* registry.write(registryEntry);
        yield* waitForRegistryEntry(subscriberEntry, { toBeDefined: true });

        expect(yield* registry.read([subscriberEntry])).toEqual(
          registryServiceMap,
        );

        const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000);
        yield* fs.utimes(entryPath, tenMinAgo, tenMinAgo);
        yield* waitForRegistryEntry(subscriberEntry, { toBeDefined: false });

        expect(yield* registry.read([subscriberEntry])).toEqual({});
        // A crashed provider cannot run its finalizer. Refresh must actively
        // reap the expired file rather than leave ignored garbage on disk.
        expect(yield* fs.exists(entryPath)).toBe(false);
      }).pipe(Effect.provide(services)),
    );

    it.live("resolves entries written before the registry starts", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        // Both registries must share the same home directory, so we can't use
        // the per-layer temp directory from `configProvider`.
        const home = yield* fs.makeTempDirectoryScoped({
          prefix: "cloudflare-runtime-test",
        });
        const sharedServices = Registry.RegistryLive.pipe(
          Layer.provideMerge(Paths.PathsLive),
          Layer.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({
                CLOUDFLARE_RUNTIME_HOME: home,
                CLOUDFLARE_RUNTIME_FILE_SYSTEM_SUPPORTS_WATCHER:
                  fileSystemSupportsWatcher,
              }),
            ),
          ),
          Layer.provideMerge(NodeServices.layer),
        );

        const scriptName = `test-worker-${fileSystemSupportsWatcher ? "watcher" : "polling"}-6`;
        const entry = registryEntry(scriptName);
        const subscriber = subscriberEntry(scriptName);

        // Provider: write the entry, keeping it alive for the test duration.
        const providerScope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(providerScope, Exit.void));
        yield* Registry.Registry.pipe(
          Effect.flatMap((registry) => registry.write(entry)),
          Effect.provide(sharedServices),
          Scope.provide(providerScope),
        );

        // Consumer: a registry started after the entry was written must
        // resolve it on the first read, without waiting for a future
        // filesystem event (e.g. the provider's heartbeat).
        const resolved = yield* Registry.Registry.pipe(
          Effect.flatMap((registry) => registry.read([subscriber])),
          Effect.provide(sharedServices),
        );
        expect(resolved).toEqual(registryServiceMap(scriptName));
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    it.live(
      "publishes complete entries atomically during creation and replacement",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          let publishedPath: string;
          let previous: string | undefined;
          const observedFs = FileSystem.FileSystem.of({
            ...fs,
            writeFileString: (file, content, options) =>
              fs.writeFileString(file, content, options).pipe(
                Effect.tap(() =>
                  Effect.gen(function* () {
                    // Inspect the public file after the bytes are written, before rename.
                    const published = yield* fs
                      .readFileString(publishedPath)
                      .pipe(Effect.orElseSucceed(() => undefined));
                    expect(published).toBe(previous);
                  }),
                ),
              ),
          });
          const registryServices = Registry.RegistryLive.pipe(
            Layer.provideMerge(Paths.PathsLive),
            Layer.provide(configProvider({ fileSystemSupportsWatcher })),
            Layer.provide(Layer.succeed(FileSystem.FileSystem)(observedFs)),
          );
          yield* Effect.gen(function* () {
            const directory = yield* Paths.state("alchemy", "registry");
            publishedPath = path.join(directory, "atomic-write.json");
            const registry = yield* Registry.Registry;
            const entry = registryEntry("atomic-write");
            yield* registry.write(entry);
            previous = JSON.stringify(entry, null, 2);
            expect(yield* fs.readFileString(publishedPath)).toBe(previous);
            const replacement = {
              ...entry,
              debugPortAddress: "127.0.0.1:23456",
            };
            yield* registry.write(replacement);
            expect(JSON.parse(yield* fs.readFileString(publishedPath))).toEqual(
              replacement,
            );
            expect(yield* fs.readDirectory(directory)).toEqual([
              "atomic-write.json",
            ]);
          }).pipe(Effect.provide(registryServices));
        }).pipe(Effect.provide(NodeServices.layer)),
    );

    it.live("a partial external write does not stop registry updates", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({
          prefix: "cloudflare-runtime-test",
        });
        const partialRead = yield* Deferred.make<void>();
        const entry = registryEntry("partial-write");
        const subscriber = subscriberEntry(entry.scriptName);
        const observedFs = FileSystem.FileSystem.of({
          ...fs,
          readFileString: (path, encoding) =>
            fs
              .readFileString(path, encoding)
              .pipe(
                Effect.tap((content) =>
                  content === "{"
                    ? Deferred.succeed(partialRead, undefined)
                    : Effect.void,
                ),
              ),
        });
        const registryServices = Registry.RegistryLive.pipe(
          Layer.provideMerge(Paths.PathsLive),
          Layer.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({
                CLOUDFLARE_RUNTIME_HOME: home,
                CLOUDFLARE_RUNTIME_FILE_SYSTEM_SUPPORTS_WATCHER:
                  fileSystemSupportsWatcher,
              }),
            ),
          ),
          Layer.provide(Layer.succeed(FileSystem.FileSystem)(observedFs)),
        );
        yield* Effect.gen(function* () {
          const path = yield* Path.Path;
          const directory = yield* Paths.state("alchemy", "registry");
          const entryPath = path.join(directory, `${entry.scriptName}.json`);
          const registry = yield* Registry.Registry;
          const queue = yield* Queue.unbounded<ResolvedTargetMap, Done<void>>();
          yield* registry
            .subscribe([subscriber])
            .pipe(Stream.runIntoQueue(queue), Effect.forkScoped);
          expect(yield* Queue.take(queue)).toEqual({});
          // Another process can expose an empty/truncated file before its write completes.
          yield* fs.writeFileString(entryPath, "{");
          yield* Deferred.await(partialRead);
          yield* fs.writeFileString(entryPath, JSON.stringify(entry));
          expect(
            yield* Queue.take(queue).pipe(Effect.timeout("3 seconds")),
          ).toEqual(registryServiceMap(entry.scriptName));
        }).pipe(Effect.provide(registryServices));
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    it.live("subscribe fires when the registry changes", () =>
      Effect.gen(function* () {
        const registry = yield* Registry.Registry;
        const { registryEntry, subscriberEntry, registryServiceMap } =
          yield* makeTestData("5");
        const queue = yield* Queue.unbounded<ResolvedTargetMap, Done<void>>();
        yield* registry
          .subscribe([subscriberEntry])
          .pipe(Stream.runIntoQueue(queue), Effect.forkScoped);
        const first = yield* Queue.take(queue);
        expect(first).toEqual({});
        const scope = yield* Scope.make();
        yield* registry.write(registryEntry).pipe(Scope.provide(scope));
        const second = yield* Queue.take(queue);
        expect(second).toMatchObject(registryServiceMap);
        yield* Scope.close(scope, Exit.void);
        const third = yield* Queue.take(queue);
        expect(third).toEqual({});
      }).pipe(Effect.provide(services)),
    );
  },
);

const registryEntry = (scriptName: string): RegistryEntry => ({
  scriptName,
  debugPortAddress: "127.0.0.1:12345",
  services: [
    {
      kind: "worker",
      fetchService: "user",
      rpcService: "user",
    },
  ],
});

const subscriberEntry = (scriptName: string): Subscriber => ({
  kind: "worker",
  scriptName,
});

const registryServiceMap = (scriptName: string): ResolvedTargetMap => {
  const service: ResolvedTarget<Subscriber.Worker> = {
    scriptName,
    debugPortAddress: "127.0.0.1:12345",
    kind: "worker",
    fetchService: "user",
    rpcService: "user",
  };
  return {
    [resolvedTargetKey(service)]: service,
  };
};
