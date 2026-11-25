import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as References from "effect/References";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { CLOUD_LINKED_USER_ID } from "../cloud/config.ts";
import * as ServerConfig from "../config.ts";
import * as Identify from "./Identify.ts";

interface CapturedLog {
  readonly message: unknown;
  readonly annotations: Readonly<Record<string, unknown>>;
}

const sha256 = Effect.fn("test.sha256")(function* (value: string) {
  const digest = yield* Digest.Digest;
  return Hex.encode(
    yield* digest.digest(Digest.sha256, new TextEncoder().encode(value)).pipe(Effect.orDie),
  );
});

const makeCaptureLogger = (logs: CapturedLog[]) =>
  Logger.make(({ fiber, message }) => {
    logs.push({
      message,
      annotations: fiber.getRef(References.CurrentLogAnnotations),
    });
  });

const findIdentityLog = (logs: ReadonlyArray<CapturedLog>, errorTag: string) =>
  logs.find((log) => log.annotations.errorTag === errorTag);

const layerIdentity = (prefix: string, logs?: CapturedLog[]) =>
  Layer.provideMerge(
    ServerSecretStore.layer,
    ServerConfig.layerTest(process.cwd(), { prefix }),
  ).pipe(
    Layer.merge(
      logs === undefined
        ? Layer.empty
        : Logger.layer([makeCaptureLogger(logs)], { mergeWithExisting: false }),
    ),
  );

const writeHomeFile = Effect.fn("test.writeHomeFile")(function* (
  homeDirectory: string,
  relativePath: string,
  contents: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const filePath = path.join(homeDirectory, relativePath);
  yield* fileSystem.makeDirectory(path.dirname(filePath), { recursive: true });
  yield* fileSystem.writeFileString(filePath, contents);
  return filePath;
});

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("telemetry identity", (it) => {
  it.effect("uses the install id as distinct_id and ignores provider sign-in files", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const homeDirectory = path.join(config.baseDir, "home");
      yield* fileSystem.writeFileString(config.anonymousIdPath, "persisted-anonymous-id");
      yield* writeHomeFile(homeDirectory, ".codex/auth.json", `{"tokens":{"account_id":"ws-1"}}`);
      yield* writeHomeFile(homeDirectory, ".claude.json", `{"userID":"claude-machine"}`);
      const installId = yield* sha256("persisted-anonymous-id");

      assert.deepEqual(
        yield* Identify.getTelemetryIdentity.pipe(
          Effect.provideService(HostProcess.HomeDirectory, homeDirectory),
        ),
        { distinctId: installId, installId },
      );
    }).pipe(Effect.provide(layerIdentity("t3-telemetry-identify-install-"))),
  );

  it.effect("leaves no torn anonymous id behind when its write fails midway", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const tornWrites = FileSystem.FileSystem.of({
        ...fileSystem,
        open: (filePath, options) =>
          fileSystem.open(filePath, options).pipe(
            Effect.map((file): FileSystem.File =>
              Object.assign(Object.create(file), {
                writeAll: (buffer: Uint8Array) =>
                  file.writeAll(buffer.subarray(0, Math.floor(buffer.length / 2))).pipe(
                    Effect.andThen(
                      Effect.fail(
                        PlatformError.systemError({
                          _tag: "WriteZero",
                          module: "FileSystem",
                          method: "writeAll",
                          pathOrDescriptor: filePath,
                        }),
                      ),
                    ),
                  ),
              }),
            ),
          ),
      });

      const identity = yield* Identify.getTelemetryIdentity.pipe(
        Effect.provideService(FileSystem.FileSystem, tornWrites),
      );

      assert.deepEqual(identity, { distinctId: null, installId: null });
      assert.isFalse(yield* fileSystem.exists(config.anonymousIdPath));
    }).pipe(Effect.provide(layerIdentity("t3-telemetry-identify-torn-"))),
  );

  it.effect("does not overwrite the anonymous id path after a non-NotFound read failure", () => {
    const logs: CapturedLog[] = [];

    return Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      yield* fileSystem.makeDirectory(config.anonymousIdPath);

      const identity = yield* Identify.getTelemetryIdentity;
      assert.deepEqual(identity, { distinctId: null, installId: null });
      assert.deepEqual(yield* fileSystem.readDirectory(config.anonymousIdPath), []);

      const readLog = findIdentityLog(logs, "TelemetryIdentityReadError");
      assert.equal(readLog?.annotations.filePath, config.anonymousIdPath);
      assert.notEqual(readLog?.annotations.platformReason, "NotFound");
      assert.notProperty(readLog?.annotations ?? {}, "cause");
      assert.isUndefined(findIdentityLog(logs, "TelemetryAnonymousIdPersistenceError"));
    }).pipe(Effect.provide(layerIdentity("t3-telemetry-identify-read-", logs)));
  });

  it.effect("reads only the linked Connect account as an owner", () =>
    Effect.gen(function* () {
      const secrets = yield* ServerSecretStore.ServerSecretStore;
      assert.deepEqual(yield* Identify.getServerOwners, []);

      yield* secrets.set(CLOUD_LINKED_USER_ID, new TextEncoder().encode("user_connect"));

      assert.deepEqual(yield* Identify.getServerOwners, [
        { source: "connect", ownerId: yield* sha256("user_connect") },
      ]);
    }).pipe(Effect.provide(layerIdentity("t3-telemetry-identify-owners-"))),
  );
});
