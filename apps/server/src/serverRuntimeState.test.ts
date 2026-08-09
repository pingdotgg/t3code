import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as References from "effect/References";
import * as Schema from "effect/Schema";

import * as ServerRuntimeState from "./serverRuntimeState.ts";

const isServerRuntimeStateError = Schema.is(ServerRuntimeState.ServerRuntimeStateError);

interface CapturedLog {
  readonly message: unknown;
  readonly annotations: Readonly<Record<string, unknown>>;
}

describe("serverRuntimeState", () => {
  it.effect("persists and reads the runtime state", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-runtime-state-test-",
      });
      const statePath = path.join(root, "runtime", "server.json");
      const state: ServerRuntimeState.PersistedServerRuntimeState = {
        version: 1,
        pid: 123,
        host: "127.0.0.1",
        port: 4_971,
        origin: "http://127.0.0.1:4971",
        devUrl: "http://localhost:5733/",
        startedAt: "2026-06-20T00:00:00.000Z",
      };

      yield* ServerRuntimeState.persistServerRuntimeState({ path: statePath, state });
      const restored = yield* ServerRuntimeState.readPersistedServerRuntimeState(statePath);

      assert.deepEqual(Option.getOrThrow(restored), state);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("records the dev web URL when the server fronts a dev server", () =>
    Effect.gen(function* () {
      const state = yield* ServerRuntimeState.makePersistedServerRuntimeState({
        config: { host: undefined, devUrl: new URL("http://localhost:5733") },
        port: 13_773,
      });

      assert.equal(state.devUrl, "http://localhost:5733/");
      assert.equal(state.origin, "http://127.0.0.1:13773");

      const withoutDev = yield* ServerRuntimeState.makePersistedServerRuntimeState({
        config: { host: undefined, devUrl: undefined },
        port: 13_773,
      });
      assert.isFalse("devUrl" in withoutDev);
    }),
  );

  it.effect("treats a missing runtime state file as absent", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-runtime-state-test-",
      });

      const restored = yield* ServerRuntimeState.readPersistedServerRuntimeState(
        path.join(root, "missing.json"),
      );

      assert.isTrue(Option.isNone(restored));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("only clears runtime state owned by the stopping server", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-runtime-state-test-",
      });
      const statePath = path.join(root, "server.json");
      const liveState: ServerRuntimeState.PersistedServerRuntimeState = {
        version: 1,
        pid: 456,
        port: 3_774,
        origin: "http://127.0.0.1:3774",
        startedAt: "2026-08-08T18:42:31.153Z",
      };

      yield* ServerRuntimeState.persistServerRuntimeState({ path: statePath, state: liveState });
      yield* ServerRuntimeState.clearPersistedServerRuntimeStateIfOwned({
        path: statePath,
        state: { pid: 123, startedAt: "2026-08-08T18:42:26.000Z" },
      });
      yield* ServerRuntimeState.clearPersistedServerRuntimeStateIfOwned({
        path: statePath,
        state: { pid: liveState.pid, startedAt: "2026-08-08T18:42:26.000Z" },
      });

      const preserved = yield* ServerRuntimeState.readPersistedServerRuntimeState(statePath);
      assert.deepEqual(Option.getOrThrow(preserved), liveState);

      yield* ServerRuntimeState.clearPersistedServerRuntimeStateIfOwned({
        path: statePath,
        state: liveState,
      });
      const cleared = yield* ServerRuntimeState.readPersistedServerRuntimeState(statePath);
      assert.isTrue(Option.isNone(cleared));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("does not rename another server's state while checking ownership", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-runtime-state-owner-test-",
      });
      const statePath = path.join(root, "server.json");
      const replacementState: ServerRuntimeState.PersistedServerRuntimeState = {
        version: 1,
        pid: 456,
        port: 3_774,
        origin: "http://127.0.0.1:3774",
        startedAt: "2026-08-09T05:10:06.000Z",
      };
      yield* ServerRuntimeState.persistServerRuntimeState({
        path: statePath,
        state: replacementState,
      });

      let renameAttempted = false;
      const observedFileSystem = {
        ...fileSystem,
        rename: (from: string, to: string) => {
          if (from === statePath) {
            renameAttempted = true;
          }
          return fileSystem.rename(from, to);
        },
      } satisfies FileSystem.FileSystem;

      yield* ServerRuntimeState.clearPersistedServerRuntimeStateIfOwned({
        path: statePath,
        state: { pid: 123, startedAt: "2026-08-09T05:09:57.000Z" },
      }).pipe(Effect.provideService(FileSystem.FileSystem, observedFileSystem));

      assert.isFalse(renameAttempted);
      assert.deepEqual(
        Option.getOrThrow(yield* ServerRuntimeState.readPersistedServerRuntimeState(statePath)),
        replacementState,
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("preserves replacement state written before ownership capture", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-runtime-state-race-test-",
      });
      const statePath = path.join(root, "server.json");
      const stoppingState: ServerRuntimeState.PersistedServerRuntimeState = {
        version: 1,
        pid: 123,
        port: 3_773,
        origin: "http://127.0.0.1:3773",
        startedAt: "2026-08-09T05:09:57.000Z",
      };
      const replacementState: ServerRuntimeState.PersistedServerRuntimeState = {
        version: 1,
        pid: 456,
        port: 3_773,
        origin: "http://127.0.0.1:3773",
        startedAt: "2026-08-09T05:10:06.000Z",
      };

      yield* ServerRuntimeState.persistServerRuntimeState({
        path: statePath,
        state: stoppingState,
      });
      const racingFileSystem = {
        ...fileSystem,
        rename: (from: string, to: string) =>
          from === statePath
            ? fileSystem
                .writeFileString(statePath, `${JSON.stringify(replacementState)}\n`)
                .pipe(Effect.andThen(fileSystem.rename(from, to)))
            : fileSystem.rename(from, to),
      } satisfies FileSystem.FileSystem;

      yield* ServerRuntimeState.clearPersistedServerRuntimeStateIfOwned({
        path: statePath,
        state: stoppingState,
      }).pipe(Effect.provideService(FileSystem.FileSystem, racingFileSystem));

      const preserved = yield* ServerRuntimeState.readPersistedServerRuntimeState(statePath);
      assert.deepEqual(Option.getOrThrow(preserved), replacementState);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("preserves replacement state written after ownership capture", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-runtime-state-race-test-",
      });
      const statePath = path.join(root, "server.json");
      const stoppingState: ServerRuntimeState.PersistedServerRuntimeState = {
        version: 1,
        pid: 123,
        port: 3_773,
        origin: "http://127.0.0.1:3773",
        startedAt: "2026-08-09T05:09:57.000Z",
      };
      const replacementState: ServerRuntimeState.PersistedServerRuntimeState = {
        version: 1,
        pid: 456,
        port: 3_773,
        origin: "http://127.0.0.1:3773",
        startedAt: "2026-08-09T05:10:06.000Z",
      };

      yield* ServerRuntimeState.persistServerRuntimeState({
        path: statePath,
        state: stoppingState,
      });
      const racingFileSystem = {
        ...fileSystem,
        rename: (from: string, to: string) =>
          from === statePath
            ? fileSystem
                .rename(from, to)
                .pipe(
                  Effect.andThen(
                    fileSystem.writeFileString(statePath, `${JSON.stringify(replacementState)}\n`),
                  ),
                )
            : fileSystem.rename(from, to),
      } satisfies FileSystem.FileSystem;

      yield* ServerRuntimeState.clearPersistedServerRuntimeStateIfOwned({
        path: statePath,
        state: stoppingState,
      }).pipe(Effect.provideService(FileSystem.FileSystem, racingFileSystem));

      const preserved = yield* ServerRuntimeState.readPersistedServerRuntimeState(statePath);
      assert.deepEqual(Option.getOrThrow(preserved), replacementState);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("restores replacement state when the filesystem rejects hard links", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-runtime-state-link-fallback-test-",
      });
      const statePath = path.join(root, "server.json");
      const replacementState: ServerRuntimeState.PersistedServerRuntimeState = {
        version: 1,
        pid: 456,
        port: 3_773,
        origin: "http://127.0.0.1:3773",
        startedAt: "2026-08-09T05:10:06.000Z",
      };

      yield* ServerRuntimeState.persistServerRuntimeState({
        path: statePath,
        state: replacementState,
      });
      const noHardLinksFileSystem = {
        ...fileSystem,
        link: (from: string, to: string) =>
          from.includes(".clearing-")
            ? fileSystem.link(path.join(root, "missing-link-source"), to)
            : fileSystem.link(from, to),
      } satisfies FileSystem.FileSystem;

      yield* ServerRuntimeState.clearPersistedServerRuntimeStateIfOwned({
        path: statePath,
        state: { pid: 123, startedAt: "2026-08-09T05:09:57.000Z" },
      }).pipe(Effect.provideService(FileSystem.FileSystem, noHardLinksFileSystem));

      const preserved = yield* ServerRuntimeState.readPersistedServerRuntimeState(statePath);
      assert.deepEqual(Option.getOrThrow(preserved), replacementState);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("preserves malformed state decode failures", () => {
    const logs: CapturedLog[] = [];
    const logger = Logger.make(({ fiber, message }) => {
      logs.push({
        message,
        annotations: fiber.getRef(References.CurrentLogAnnotations),
      });
    });

    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-runtime-state-test-",
      });
      const statePath = path.join(root, "server.json");
      yield* fileSystem.writeFileString(statePath, "{not json");

      const restored = yield* ServerRuntimeState.readPersistedServerRuntimeState(statePath);

      assert.isTrue(Option.isNone(restored));
      assert.equal(logs[0]?.message, `Failed to decode server runtime state at ${statePath}.`);
      const error = logs[0]?.annotations.cause;
      assert.isTrue(isServerRuntimeStateError(error));
      if (isServerRuntimeStateError(error)) {
        assert.equal(error.operation, "decode");
        assert.equal(error.statePath, statePath);
        assert.equal(error.message, `Failed to decode server runtime state at ${statePath}.`);
        assert.deepInclude(error.cause, { _tag: "SchemaError" });
      }
    }).pipe(
      Effect.provide(
        Layer.merge(NodeServices.layer, Logger.layer([logger], { mergeWithExisting: false })),
      ),
    );
  });

  it.effect("preserves runtime state read failures", () => {
    const logs: CapturedLog[] = [];
    const logger = Logger.make(({ fiber, message }) => {
      logs.push({
        message,
        annotations: fiber.getRef(References.CurrentLogAnnotations),
      });
    });

    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-runtime-state-test-",
      });
      const statePath = path.join(root, "server.json");
      yield* fileSystem.makeDirectory(statePath);

      const restored = yield* ServerRuntimeState.readPersistedServerRuntimeState(statePath);

      assert.isTrue(Option.isNone(restored));
      assert.equal(logs[0]?.message, `Failed to read server runtime state at ${statePath}.`);
      const error = logs[0]?.annotations.cause;
      assert.isTrue(isServerRuntimeStateError(error));
      if (isServerRuntimeStateError(error)) {
        assert.equal(error.operation, "read");
        assert.equal(error.statePath, statePath);
        assert.equal(error.message, `Failed to read server runtime state at ${statePath}.`);
        assert.deepInclude(error.cause, { _tag: "PlatformError" });
      }
    }).pipe(
      Effect.provide(
        Layer.merge(NodeServices.layer, Logger.layer([logger], { mergeWithExisting: false })),
      ),
    );
  });

  it.effect("preserves runtime state persistence failures", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-runtime-state-test-",
      });
      const blockedDirectory = path.join(root, "not-a-directory");
      const statePath = path.join(blockedDirectory, "server.json");
      yield* fileSystem.writeFileString(blockedDirectory, "blocked");

      const error = yield* ServerRuntimeState.persistServerRuntimeState({
        path: statePath,
        state: {
          version: 1,
          pid: 123,
          port: 4_971,
          origin: "http://127.0.0.1:4971",
          startedAt: "2026-06-20T00:00:00.000Z",
        },
      }).pipe(Effect.flip);

      assert.isTrue(isServerRuntimeStateError(error));
      if (isServerRuntimeStateError(error)) {
        assert.equal(error.operation, "persist");
        assert.equal(error.statePath, statePath);
        assert.equal(error.message, `Failed to persist server runtime state at ${statePath}.`);
        assert.deepInclude(error.cause, { _tag: "PlatformError" });
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
