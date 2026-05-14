import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, type PersistedSavedEnvironmentRecord } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
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
const decodeSavedEnvironmentRegistryDocumentProbe = Schema.decodeEffect(
  Schema.fromJsonString(SavedEnvironmentRegistryDocumentProbe),
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
            new ElectronSafeStorage.ElectronSafeStorageAvailabilityError({
              cause: input.availabilityError,
            }),
          ),
    encryptString: (value) =>
      input.encryptError === undefined
        ? Effect.succeed(textEncoder.encode(`enc:${value}`))
        : Effect.fail(
            new ElectronSafeStorage.ElectronSafeStorageEncryptError({
              cause: input.encryptError,
            }),
          ),
    decryptString: (value) => {
      if (input.decryptError !== undefined) {
        return Effect.fail(
          new ElectronSafeStorage.ElectronSafeStorageDecryptError({
            cause: input.decryptError,
          }),
        );
      }

      const decoded = textDecoder.decode(value);
      if (!decoded.startsWith("enc:")) {
        return Effect.fail(
          new ElectronSafeStorage.ElectronSafeStorageDecryptError({
            cause: new Error("invalid secret"),
          }),
        );
      }
      return Effect.succeed(decoded.slice("enc:".length));
    },
  } satisfies ElectronSafeStorage.ElectronSafeStorageShape);
}

function makeLayer(
  baseDir: string,
  options?: {
    readonly availableSecretStorage?: boolean;
    readonly availabilityError?: unknown;
    readonly encryptError?: unknown;
    readonly decryptError?: unknown;
  },
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

  return DesktopSavedEnvironments.layer.pipe(
    Layer.provideMerge(environmentLayer),
    Layer.provideMerge(
      makeSafeStorageLayer({
        available: options?.availableSecretStorage ?? true,
        availabilityError: options?.availabilityError,
        encryptError: options?.encryptError,
        decryptError: options?.decryptError,
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
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

        assert.instanceOf(error, ElectronSafeStorage.ElectronSafeStorageAvailabilityError);
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

  it.effect("treats malformed saved environment documents as empty", () =>
    withSavedEnvironments(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const savedEnvironments = yield* DesktopSavedEnvironments.DesktopSavedEnvironments;
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* fileSystem.writeFileString(environment.savedEnvironmentRegistryPath, "{not-json");

        assert.deepEqual(yield* savedEnvironments.getRegistry, []);
        assert.isTrue(
          Option.isNone(yield* savedEnvironments.getSecret(savedRegistryRecord.environmentId)),
        );
      }),
    ),
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
