// @effect-diagnostics nodeBuiltinImport:off -- The child fixture proves writer liveness and crash cleanup across processes.
import * as NodeChildProcess from "node:child_process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as PlatformError from "effect/PlatformError";

import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";

const layerServerConfig = () =>
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-secret-store-test-" });

const layerServerSecretStore = () => Layer.provide(ServerSecretStore.layer, layerServerConfig());

const layerPermissionDeniedFileSystem = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;

    return {
      ...fileSystem,
      readFile: (path) =>
        Effect.fail(
          PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "readFile",
            pathOrDescriptor: path,
            description: "Permission denied while reading secret file.",
          }),
        ),
    } satisfies FileSystem.FileSystem;
  }),
).pipe(Layer.provide(NodeServices.layer));

const layerPermissionDeniedSecretStore = () =>
  ServerSecretStore.layer.pipe(
    Layer.provide(layerServerConfig()),
    Layer.provideMerge(layerPermissionDeniedFileSystem),
  );

const layerRenameFailureFileSystem = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;

    return {
      ...fileSystem,
      rename: (from, to) =>
        Effect.fail(
          PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "rename",
            pathOrDescriptor: `${String(from)} -> ${String(to)}`,
            description: "Permission denied while persisting secret file.",
          }),
        ),
    } satisfies FileSystem.FileSystem;
  }),
).pipe(Layer.provide(NodeServices.layer));

const layerRenameFailureSecretStore = () =>
  ServerSecretStore.layer.pipe(
    Layer.provide(layerServerConfig()),
    Layer.provideMerge(layerRenameFailureFileSystem),
  );

const layerConcurrentReadMissFileSystem = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const readCountRef = yield* Ref.make(0);
    const readBarrier = yield* Deferred.make<void>();

    return {
      ...fileSystem,
      readFile: (path) =>
        /[\\/]session-signing-key\.bin$/.test(String(path))
          ? Ref.updateAndGet(readCountRef, (count) => count + 1).pipe(
              Effect.flatMap((count) => {
                if (count > 2) {
                  return fileSystem.readFile(path);
                }
                return Effect.gen(function* () {
                  if (count === 2) {
                    yield* Deferred.succeed(readBarrier, void 0);
                  }
                  yield* Deferred.await(readBarrier);
                  return yield* Effect.failCause(
                    Cause.fail(
                      PlatformError.systemError({
                        _tag: "NotFound",
                        module: "FileSystem",
                        method: "readFile",
                        pathOrDescriptor: String(path),
                        description: "Secret file does not exist yet.",
                      }),
                    ),
                  );
                });
              }),
            )
          : fileSystem.readFile(path),
    } satisfies FileSystem.FileSystem;
  }),
).pipe(Layer.provide(NodeServices.layer));

const layerConcurrentCreateSecretStore = () =>
  ServerSecretStore.layer.pipe(
    Layer.provide(layerServerConfig()),
    Layer.provideMerge(layerConcurrentReadMissFileSystem),
  );

it.layer(NodeServices.layer)("ServerSecretStore.layer", (it) => {
  it.effect("reuses an existing secret instead of regenerating it", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;

      const first = yield* secretStore.getOrCreateRandom("session-signing-key", 32);
      const second = yield* secretStore.getOrCreateRandom("session-signing-key", 32);

      assert.deepEqual(Array.from(second), Array.from(first));
    }).pipe(Effect.provide(layerServerSecretStore())),
  );

  it.effect("returns the persisted secret when concurrent creators race", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;

      const [first, second] = yield* Effect.all(
        [
          secretStore.getOrCreateRandom("session-signing-key", 32),
          secretStore.getOrCreateRandom("session-signing-key", 32),
        ],
        { concurrency: "unbounded" },
      );
      const persisted = yield* secretStore.get("session-signing-key");
      const persistedBytes = Option.getOrThrow(persisted);

      assert.deepEqual(Array.from(first), Array.from(persistedBytes));
      assert.deepEqual(Array.from(second), Array.from(persistedBytes));
    }).pipe(Effect.provide(layerConcurrentCreateSecretStore())),
  );

  it.effect.each([false, true])(
    "cleans crash temporaries at startup with a final secret: %s",
    (hasFinal) =>
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(config.secretsDir, { recursive: true });
        const final = `${config.secretsDir}/plugin-setting-test.bin`;
        const temporary = `${final}.00000000-0000-4000-8000-000000000001.tmp`;
        const reusedPidTemporary = `${final}.${process.pid}-00000000.00000000-0000-4000-8000-000000000002.tmp`;
        const legacyPidTemporary = `${final}.${process.pid}.00000000-0000-4000-8000-000000000003.tmp`;
        const unrelated = `${config.secretsDir}/notes.tmp`;
        if (hasFinal) yield* fs.writeFileString(final, "old-secret");
        yield* fs.writeFileString(temporary, "new-secret");
        yield* fs.writeFileString(reusedPidTemporary, "old-instance-secret");
        yield* fs.writeFileString(legacyPidTemporary, "legacy-instance-secret");
        yield* fs.writeFileString(unrelated, "keep");
        const store = yield* ServerSecretStore.make;
        assert.isFalse(yield* fs.exists(temporary));
        assert.isFalse(yield* fs.exists(reusedPidTemporary));
        assert.isFalse(yield* fs.exists(legacyPidTemporary));
        assert.isTrue(yield* fs.exists(unrelated));
        assert.equal(Option.isSome(yield* store.get("plugin-setting-test")), hasFinal);
        if (hasFinal) assert.equal(yield* fs.readFileString(final), "old-secret");
      }).pipe(Effect.provide(layerServerConfig())),
  );

  it.effect("removes orphan temporaries when the final secret is missing", () =>
    Effect.gen(function* () {
      const store = yield* ServerSecretStore.ServerSecretStore;
      const fs = yield* FileSystem.FileSystem;
      const temporary = `${store.directory}/plugin-setting-test.bin.00000000-0000-4000-8000-000000000001.tmp`;
      const other = `${store.directory}/other.bin.00000000-0000-4000-8000-000000000001.tmp`;
      yield* fs.writeFileString(temporary, "secret");
      yield* fs.writeFileString(other, "other-secret");
      yield* store.remove("plugin-setting-test");
      assert.isFalse(yield* fs.exists(temporary));
      assert.isTrue(yield* fs.exists(other));
    }).pipe(Effect.provide(layerServerSecretStore())),
  );

  it.effect("a second store preserves an active replacement during startup and removal", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;
      const written = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      const writer = yield* ServerSecretStore.make.pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          rename: (from, to) =>
            Deferred.succeed(written, undefined).pipe(
              Effect.andThen(Deferred.await(finish)),
              Effect.andThen(fs.rename(from, to)),
            ),
        }),
      );
      yield* Effect.addFinalizer(() => Deferred.succeed(finish, undefined));
      const writing = yield* writer
        .set("shared-secret", Uint8Array.from([1, 2, 3]))
        .pipe(Effect.forkChild);
      yield* Deferred.await(written);
      const replacement = (yield* fs.readDirectory(config.secretsDir)).find((name) =>
        name.endsWith(".tmp"),
      )!;
      const second = yield* ServerSecretStore.make;
      yield* second.remove("shared-secret");
      assert.isTrue(yield* fs.exists(`${config.secretsDir}/${replacement}`));
      yield* Deferred.succeed(finish, undefined);
      yield* Fiber.join(writing);
      assert.deepEqual(
        Array.from(Option.getOrThrow(yield* second.get("shared-secret"))),
        [1, 2, 3],
      );
      assert.isFalse(yield* fs.exists(`${config.secretsDir}/${replacement}`));
    }).pipe(Effect.provide(layerServerConfig())),
  );

  it.effect("a second store preserves an active create during startup and removal", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;
      const written = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      const writer = yield* ServerSecretStore.make.pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          link: (from, to) =>
            Deferred.succeed(written, undefined).pipe(
              Effect.andThen(Deferred.await(finish)),
              Effect.andThen(fs.link(from, to)),
            ),
        }),
      );
      yield* Effect.addFinalizer(() => Deferred.succeed(finish, undefined));
      const writing = yield* writer
        .create("shared-secret", Uint8Array.from([1, 2, 3]))
        .pipe(Effect.forkChild);
      yield* Deferred.await(written);
      const replacement = (yield* fs.readDirectory(config.secretsDir)).find((name) =>
        name.endsWith(".tmp"),
      )!;
      const second = yield* ServerSecretStore.make;
      yield* second.remove("shared-secret");
      assert.isTrue(yield* fs.exists(`${config.secretsDir}/${replacement}`));
      yield* Deferred.succeed(finish, undefined);
      yield* Fiber.join(writing);
      assert.deepEqual(
        Array.from(Option.getOrThrow(yield* second.get("shared-secret"))),
        [1, 2, 3],
      );
      assert.isFalse(yield* fs.exists(`${config.secretsDir}/${replacement}`));
    }).pipe(Effect.provide(layerServerConfig())),
  );

  it.effect("cleans its temporary when a replacement is interrupted", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;
      const written = yield* Deferred.make<void>();
      const writer = yield* ServerSecretStore.make.pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          rename: () => Deferred.succeed(written, undefined).pipe(Effect.andThen(Effect.never)),
        }),
      );
      const writing = yield* writer
        .set("interrupted-secret", Uint8Array.from([1]))
        .pipe(Effect.forkChild);
      yield* Deferred.await(written);
      yield* Fiber.interrupt(writing);
      assert.deepEqual(yield* fs.readDirectory(config.secretsDir), []);
    }).pipe(Effect.provide(layerServerConfig())),
  );

  it.effect("retains a foreign live writer's temporary and sweeps it after exit", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;
      yield* fs.makeDirectory(config.secretsDir, { recursive: true });
      const child = yield* Effect.acquireRelease(
        Effect.sync(() =>
          NodeChildProcess.spawn(
            process.execPath,
            [
              "-e",
              `
          const fs = require('node:fs');
          const path = require('node:path');
          const temporary = path.join(process.argv[1], 'foreign.bin.' + process.pid + '.00000000-0000-4000-8000-000000000001.tmp');
          fs.writeFileSync(temporary, 'crash-secret', { mode: 0o600 });
          process.on('message', () => process.exit(0));
          process.send(temporary);
        `,
              config.secretsDir,
            ],
            { stdio: ["ignore", "ignore", "ignore", "ipc"] },
          ),
        ),
        (process) =>
          Effect.promise(
            () =>
              new Promise<void>((resolve) => {
                if (process.exitCode !== null || process.signalCode !== null) return resolve();
                process.once("exit", () => resolve());
                process.kill();
              }),
          ),
      );
      const temporary = yield* Effect.tryPromise(
        () =>
          new Promise<string>((resolve, reject) => {
            child.once("message", (message) =>
              typeof message === "string"
                ? resolve(message)
                : reject(new Error("Unexpected child fixture message")),
            );
            child.once("error", reject);
            child.once("exit", () =>
              reject(new Error("Child exited before publishing its temporary")),
            );
          }),
      );
      const second = yield* ServerSecretStore.make;
      yield* second.remove("foreign");
      assert.isTrue(yield* fs.exists(temporary));
      yield* Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            child.once("exit", () => resolve());
            child.send("exit");
          }),
      );
      yield* ServerSecretStore.make;
      assert.isFalse(yield* fs.exists(temporary));
    }).pipe(Effect.provide(layerServerConfig())),
  );

  it.effect("propagates read failures other than missing-file errors", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;

      const error = yield* Effect.flip(secretStore.getOrCreateRandom("session-signing-key", 32));

      assert.instanceOf(error, ServerSecretStore.SecretStoreReadError);
      assert.include(error.message, "Failed to read secret session-signing-key.");
      assert.instanceOf(error.cause, PlatformError.PlatformError);
      assert.equal((error.cause as PlatformError.PlatformError).reason._tag, "PermissionDenied");
    }).pipe(Effect.provide(layerPermissionDeniedSecretStore())),
  );

  it.effect("propagates write failures instead of treating them as success", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;

      const error = yield* Effect.flip(
        secretStore.set("session-signing-key", Uint8Array.from([1, 2, 3])),
      );

      assert.instanceOf(error, ServerSecretStore.SecretStorePersistError);
      assert.include(error.message, "Failed to persist secret session-signing-key.");
      assert.instanceOf(error.cause, PlatformError.PlatformError);
      assert.equal((error.cause as PlatformError.PlatformError).reason._tag, "PermissionDenied");
    }).pipe(Effect.provide(layerRenameFailureSecretStore())),
  );
});
