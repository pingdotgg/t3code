import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, type PersistedSavedEnvironmentRecord } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import * as DesktopSavedEnvironments from "./DesktopSavedEnvironments.ts";

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

const savedRegistryRecord: PersistedSavedEnvironmentRecord = {
  environmentId: EnvironmentId.make("environment-1"),
  label: "Remote environment",
  httpBaseUrl: "https://remote.example.com/",
  wsBaseUrl: "wss://remote.example.com/",
  createdAt: "2026-04-09T00:00:00.000Z",
  lastConnectedAt: "2026-04-09T01:00:00.000Z",
  desktopSsh: {
    alias: "devbox",
    hostname: "devbox.example.com",
    username: "julius",
    port: 22,
  },
};

const SavedEnvironmentRegistryDocumentProbe = Schema.Struct({
  version: Schema.Number,
  records: Schema.Array(Schema.Unknown),
});
const SavedEnvironmentRegistryDocumentProbeJson = Schema.fromJsonString(
  SavedEnvironmentRegistryDocumentProbe,
);
const decodeSavedEnvironmentRegistryDocumentProbe = Schema.decodeEffect(
  SavedEnvironmentRegistryDocumentProbeJson,
);
const encodeSavedEnvironmentRegistryDocumentProbe = Schema.encodeEffect(
  SavedEnvironmentRegistryDocumentProbeJson,
);
function makeSafeStorageLayer(input: {
  readonly available: boolean;
  readonly availabilityError?: unknown;
  readonly encryptError?: unknown;
  readonly decryptError?: unknown;
}) {
  return Layer.succeed(ElectronSafeStorage.ElectronSafeStorage, {
    isEncryptionAvailable:
      input.availabilityError === undefined
        ? Effect.succeed(input.available)
        : Effect.fail(
            new ElectronSafeStorage.ElectronSafeStorageError({
              operation: "check encryption availability",
              cause: input.availabilityError,
            }),
          ),
    encryptString: (value) =>
      input.encryptError === undefined
        ? Effect.succeed(textEncoder.encode(`enc:${value}`))
        : Effect.fail(
            new ElectronSafeStorage.ElectronSafeStorageError({
              operation: "encrypt a string",
              cause: input.encryptError,
            }),
          ),
    decryptString: (value) => {
      if (input.decryptError !== undefined) {
        return Effect.fail(
          new ElectronSafeStorage.ElectronSafeStorageError({
            operation: "decrypt a string",
            cause: input.decryptError,
          }),
        );
      }

      const decoded = textDecoder.decode(value);
      if (!decoded.startsWith("enc:")) {
        return Effect.fail(
          new ElectronSafeStorage.ElectronSafeStorageError({
            operation: "decrypt a string",
            cause: new Error("invalid secret"),
          }),
        );
      }
      return Effect.succeed(decoded.slice("enc:".length));
    },
  } satisfies ElectronSafeStorage.ElectronSafeStorage["Service"]);
}

function makeLayer(
  baseDir: string,
  options?: {
    readonly availableSecretStorage?: boolean;
    readonly availabilityError?: unknown;
    readonly encryptError?: unknown;
    readonly decryptError?: unknown;
  },
  fileSystemLayer: Layer.Layer<FileSystem.FileSystem> = NodeServices.layer,
) {
  const environmentLayer = DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: baseDir,
    platform: "darwin",
    processArch: "x64",
    appVersion: "1.2.3",
    appPath: "/repo",
    isPackaged: true,
    resourcesPath: "/missing/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({ T3CODE_HOME: baseDir })),
    ),
  );

  const safeStorageLayer = makeSafeStorageLayer({
    available: options?.availableSecretStorage ?? true,
    availabilityError: options?.availabilityError,
    encryptError: options?.encryptError,
    decryptError: options?.decryptError,
  });
  const dependencies = Layer.mergeAll(
    environmentLayer,
    safeStorageLayer,
    NodeServices.layer,
    fileSystemLayer,
  );

  return DesktopSavedEnvironments.layer.pipe(Layer.provideMerge(dependencies));
}

const withSavedEnvironments = <A, E, R>(
  effect: Effect.Effect<A, E, R | DesktopSavedEnvironments.DesktopSavedEnvironments>,
  options?: {
    readonly availableSecretStorage?: boolean;
    readonly availabilityError?: unknown;
    readonly encryptError?: unknown;
    readonly decryptError?: unknown;
  },
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-desktop-saved-environments-test-",
    });
    return yield* effect.pipe(Effect.provide(makeLayer(baseDir, options)));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

describe("DesktopSavedEnvironments", () => {
  it.effect("persists and reloads saved environment metadata", () =>
    withSavedEnvironments(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const savedEnvironments = yield* DesktopSavedEnvironments.DesktopSavedEnvironments;
        yield* savedEnvironments.setRegistry([savedRegistryRecord]);

        assert.deepEqual(yield* savedEnvironments.getRegistry, [savedRegistryRecord]);
        const persisted = yield* decodeSavedEnvironmentRegistryDocumentProbe(
          yield* fileSystem.readFileString(environment.savedEnvironmentRegistryPath),
        );
        assert.equal(persisted.version, 1);
        assert.lengthOf(persisted.records, 1);
      }),
    ),
  );

  it.effect("loads lenient saved environment registry documents", () =>
    withSavedEnvironments(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const savedEnvironments = yield* DesktopSavedEnvironments.DesktopSavedEnvironments;
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* fileSystem.writeFileString(
          environment.savedEnvironmentRegistryPath,
          `{
            // Same optional envelope shape as browser saved environments.
            "version": 1,
            "records": [
              {
                "environmentId": "${savedRegistryRecord.environmentId}",
                "label": "Remote environment",
                "httpBaseUrl": "https://remote.example.com/",
                "wsBaseUrl": "wss://remote.example.com/",
                "createdAt": "2026-04-09T00:00:00.000Z",
                "lastConnectedAt": "2026-04-09T01:00:00.000Z",
                "desktopSsh": {
                  "alias": "devbox",
                  "hostname": "devbox.example.com",
                  "username": "julius",
                  "port": 22,
                },
              },
            ],
          }\n`,
        );

        assert.deepEqual(yield* savedEnvironments.getRegistry, [savedRegistryRecord]);
      }),
    ),
  );

  it.effect("persists encrypted saved environment secrets when encryption is available", () =>
    withSavedEnvironments(
      Effect.gen(function* () {
        const savedEnvironments = yield* DesktopSavedEnvironments.DesktopSavedEnvironments;
        yield* savedEnvironments.setRegistry([savedRegistryRecord]);

        assert.isTrue(
          yield* savedEnvironments.setSecret({
            environmentId: savedRegistryRecord.environmentId,
            secret: "bearer-token",
          }),
        );

        assert.deepEqual(
          yield* savedEnvironments.getSecret(savedRegistryRecord.environmentId),
          Option.some("bearer-token"),
        );
      }),
    ),
  );

  it.effect("reports invalid saved secret encoding without exposing the secret", () =>
    withSavedEnvironments(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const savedEnvironments = yield* DesktopSavedEnvironments.DesktopSavedEnvironments;
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        const encoded = yield* encodeSavedEnvironmentRegistryDocumentProbe({
          version: 1,
          records: [{ ...savedRegistryRecord, encryptedBearerToken: "%%%" }],
        });
        yield* fileSystem.writeFileString(environment.savedEnvironmentRegistryPath, `${encoded}\n`);

        const error = yield* savedEnvironments
          .getSecret(savedRegistryRecord.environmentId)
          .pipe(Effect.flip);
        assert.instanceOf(error, DesktopSavedEnvironments.DesktopSavedEnvironmentSecretDecodeError);
        assert.equal(error.environmentId, savedRegistryRecord.environmentId);
        assert.equal(error.registryPath, environment.savedEnvironmentRegistryPath);
        assert.equal(error.field, "encryptedBearerToken");
        assert.exists(error.cause);
        assert.equal(
          error.message,
          `Failed to decode encryptedBearerToken for environment ${savedRegistryRecord.environmentId} at ${environment.savedEnvironmentRegistryPath}.`,
        );
        assert.notInclude(error.message, "%%%");
      }),
    ),
  );

  it.effect("returns false when writing secrets while encryption is unavailable", () =>
    withSavedEnvironments(
      Effect.gen(function* () {
        const savedEnvironments = yield* DesktopSavedEnvironments.DesktopSavedEnvironments;
        yield* savedEnvironments.setRegistry([savedRegistryRecord]);

        assert.isFalse(
          yield* savedEnvironments.setSecret({
            environmentId: savedRegistryRecord.environmentId,
            secret: "next-token",
          }),
        );
      }),
      { availableSecretStorage: false },
    ),
  );

  it.effect("surfaces typed safe storage availability failures", () => {
    const cause = new Error("safe storage unavailable");
    return withSavedEnvironments(
      Effect.gen(function* () {
        const savedEnvironments = yield* DesktopSavedEnvironments.DesktopSavedEnvironments;
        yield* savedEnvironments.setRegistry([savedRegistryRecord]);

        const error = yield* savedEnvironments
          .setSecret({
            environmentId: savedRegistryRecord.environmentId,
            secret: "next-token",
          })
          .pipe(Effect.flip);

        assert.instanceOf(error, ElectronSafeStorage.ElectronSafeStorageError);
        assert.equal(error.operation, "check encryption availability");
        assert.equal(error.cause, cause);
      }),
      { availabilityError: cause },
    );
  });

  it.effect("removes saved environment secrets", () =>
    withSavedEnvironments(
      Effect.gen(function* () {
        const savedEnvironments = yield* DesktopSavedEnvironments.DesktopSavedEnvironments;
        yield* savedEnvironments.setRegistry([savedRegistryRecord]);
        yield* savedEnvironments.setSecret({
          environmentId: savedRegistryRecord.environmentId,
          secret: "bearer-token",
        });

        yield* savedEnvironments.removeSecret(savedRegistryRecord.environmentId);

        assert.isTrue(
          Option.isNone(yield* savedEnvironments.getSecret(savedRegistryRecord.environmentId)),
        );
      }),
    ),
  );

  it.effect("removes saved environment metadata and its embedded secret atomically", () =>
    withSavedEnvironments(
      Effect.gen(function* () {
        const savedEnvironments = yield* DesktopSavedEnvironments.DesktopSavedEnvironments;
        yield* savedEnvironments.setRegistry([savedRegistryRecord]);
        yield* savedEnvironments.setSecret({
          environmentId: savedRegistryRecord.environmentId,
          secret: "bearer-token",
        });

        yield* savedEnvironments.removeEnvironment(savedRegistryRecord.environmentId);

        assert.deepEqual(yield* savedEnvironments.getRegistry, []);
        assert.isTrue(
          Option.isNone(yield* savedEnvironments.getSecret(savedRegistryRecord.environmentId)),
        );
      }),
    ),
  );

  it.effect("treats empty saved environment documents as empty", () =>
    withSavedEnvironments(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const savedEnvironments = yield* DesktopSavedEnvironments.DesktopSavedEnvironments;
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* fileSystem.writeFileString(environment.savedEnvironmentRegistryPath, "{}\n");

        assert.deepEqual(yield* savedEnvironments.getRegistry, []);
        assert.isTrue(
          Option.isNone(yield* savedEnvironments.getSecret(savedRegistryRecord.environmentId)),
        );
      }),
    ),
  );

  it.effect("surfaces malformed saved environment documents", () =>
    withSavedEnvironments(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const savedEnvironments = yield* DesktopSavedEnvironments.DesktopSavedEnvironments;
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* fileSystem.writeFileString(environment.savedEnvironmentRegistryPath, "{not-json");

        const registryError = yield* savedEnvironments.getRegistry.pipe(Effect.flip);
        assert.instanceOf(
          registryError,
          DesktopSavedEnvironments.DesktopSavedEnvironmentsDocumentDecodeError,
        );
        assert.equal(registryError.registryPath, environment.savedEnvironmentRegistryPath);
        assert.exists(registryError.cause);
        const secretError = yield* savedEnvironments
          .getSecret(savedRegistryRecord.environmentId)
          .pipe(Effect.flip);
        assert.instanceOf(
          secretError,
          DesktopSavedEnvironments.DesktopSavedEnvironmentsDocumentDecodeError,
        );
        const mutationError = yield* savedEnvironments
          .setRegistry([savedRegistryRecord])
          .pipe(Effect.flip);
        assert.instanceOf(
          mutationError,
          DesktopSavedEnvironments.DesktopSavedEnvironmentsDocumentDecodeError,
        );
      }),
    ),
  );

  it.effect("reports saved environment filesystem reads separately from document decoding", () =>
    Effect.gen(function* () {
      const baseFileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* baseFileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-saved-environments-test-",
      });
      const registryPath = `${baseDir}/userdata/saved-environments.json`;
      const permissionError = PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "readFileString",
        pathOrDescriptor: registryPath,
      });
      const fileSystemLayer = Layer.succeed(
        FileSystem.FileSystem,
        FileSystem.makeNoop({
          readFileString: () => Effect.fail(permissionError),
        }),
      );
      const savedEnvironments = yield* DesktopSavedEnvironments.DesktopSavedEnvironments.pipe(
        Effect.provide(makeLayer(baseDir, undefined, fileSystemLayer)),
      );

      const error = yield* savedEnvironments.getRegistry.pipe(Effect.flip);
      assert.instanceOf(error, DesktopSavedEnvironments.DesktopSavedEnvironmentsReadError);
      assert.equal(error.registryPath, registryPath);
      assert.strictEqual(error.cause, permissionError);
      assert.equal(error.message, `Failed to read desktop saved environments at ${registryPath}.`);
      assert.notEqual(error.message, permissionError.message);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("reports the failed saved environment write operation and path", () =>
    Effect.gen(function* () {
      const baseFileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* baseFileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-saved-environments-test-",
      });
      const permissionError = PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "makeDirectory",
        pathOrDescriptor: `${baseDir}/userdata`,
      });
      const fileSystemLayer = Layer.succeed(
        FileSystem.FileSystem,
        FileSystem.makeNoop({
          readFileString: baseFileSystem.readFileString,
          makeDirectory: () => Effect.fail(permissionError),
        }),
      );
      const savedEnvironments = yield* DesktopSavedEnvironments.DesktopSavedEnvironments.pipe(
        Effect.provide(makeLayer(baseDir, undefined, fileSystemLayer)),
      );

      const error = yield* savedEnvironments.setRegistry([savedRegistryRecord]).pipe(Effect.flip);
      assert.instanceOf(error, DesktopSavedEnvironments.DesktopSavedEnvironmentsWriteError);
      assert.equal(error.operation, "create-directory");
      assert.equal(error.path, `${baseDir}/userdata`);
      assert.strictEqual(error.cause, permissionError);
      assert.equal(
        error.message,
        `Desktop saved-environment write failed during create-directory at ${baseDir}/userdata.`,
      );
      assert.notEqual(error.message, permissionError.message);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("returns false when writing a secret without metadata", () =>
    withSavedEnvironments(
      Effect.gen(function* () {
        const savedEnvironments = yield* DesktopSavedEnvironments.DesktopSavedEnvironments;

        assert.isFalse(
          yield* savedEnvironments.setSecret({
            environmentId: savedRegistryRecord.environmentId,
            secret: "bearer-token",
          }),
        );
      }),
    ),
  );

  it.effect("preserves encrypted secrets when metadata is rewritten", () =>
    withSavedEnvironments(
      Effect.gen(function* () {
        const savedEnvironments = yield* DesktopSavedEnvironments.DesktopSavedEnvironments;
        yield* savedEnvironments.setRegistry([savedRegistryRecord]);
        yield* savedEnvironments.setSecret({
          environmentId: savedRegistryRecord.environmentId,
          secret: "bearer-token",
        });

        yield* savedEnvironments.setRegistry([savedRegistryRecord]);

        assert.deepEqual(yield* savedEnvironments.getRegistry, [savedRegistryRecord]);
        assert.deepEqual(
          yield* savedEnvironments.getSecret(savedRegistryRecord.environmentId),
          Option.some("bearer-token"),
        );
      }),
    ),
  );
});
