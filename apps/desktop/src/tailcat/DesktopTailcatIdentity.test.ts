import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as TailcatRuntime from "@t3tools/tailcat/runtime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import * as DesktopTailcatIdentity from "./DesktopTailcatIdentity.ts";

const NODE_KEY = `nodekey:${"3c".repeat(32)}`;
const KEY_FILE_TEXT = `privkey:${"5a".repeat(32)}\n`;
const ENCRYPTED_PREFIX = "enc:";
// The TestClock starts at the epoch, so the stored record's timestamp is fixed.
const EPOCH_ISO = "1970-01-01T00:00:00.000Z";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const IdentityRecordJson = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Literal(1),
    nodeKey: Schema.String,
    keyFile: Schema.String,
    createdAt: Schema.String,
  }),
);
const decodeIdentityRecord = Schema.decodeUnknownEffect(IdentityRecordJson);

function makeSafeStorageLayer(encryptionAvailable: boolean) {
  return Layer.succeed(ElectronSafeStorage.ElectronSafeStorage, {
    isEncryptionAvailable: Effect.succeed(encryptionAvailable),
    encryptString: (value) => Effect.succeed(textEncoder.encode(`${ENCRYPTED_PREFIX}${value}`)),
    decryptString: (value) => {
      const decoded = textDecoder.decode(value);
      return decoded.startsWith(ENCRYPTED_PREFIX)
        ? Effect.succeed(decoded.slice(ENCRYPTED_PREFIX.length))
        : Effect.fail(
            new ElectronSafeStorage.ElectronSafeStorageDecryptError({
              cause: new Error("not encrypted by this test"),
            }),
          );
    },
    selectedStorageBackend: Effect.succeed(Option.none()),
  } satisfies ElectronSafeStorage.ElectronSafeStorage["Service"]);
}

/** Only `stateDir` and `path` matter to the identity; the rest is a plausible desktop. */
function makeEnvironmentLayer(baseDir: string) {
  return DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: baseDir,
    platform: "linux",
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
}

/** A tailcat that writes a fixed private key wherever it is asked to. */
function makeRuntimeLayer(generatedKeyPaths: Array<string>) {
  return Layer.unwrap(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      return Layer.mock(TailcatRuntime.TailcatRuntime)({
        generateClientIdentity: ({ keyPath }) =>
          Effect.gen(function* () {
            generatedKeyPaths.push(keyPath);
            yield* fileSystem
              .writeFileString(keyPath, KEY_FILE_TEXT, { mode: 0o600 })
              .pipe(Effect.orDie);
            return { nodeKey: NODE_KEY };
          }),
      });
    }),
  ).pipe(Layer.provide(NodeServices.layer));
}

/** One fresh identity service instance over the desktop state below `baseDir`. */
function makeIdentityLayer(
  baseDir: string,
  options: {
    readonly encryptionAvailable: boolean;
    readonly generatedKeyPaths: Array<string>;
  },
) {
  return DesktopTailcatIdentity.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        makeEnvironmentLayer(baseDir),
        makeSafeStorageLayer(options.encryptionAvailable),
        makeRuntimeLayer(options.generatedKeyPaths),
        NodeServices.layer,
      ),
    ),
  );
}

const readIdentity = Effect.gen(function* () {
  const identity = yield* DesktopTailcatIdentity.DesktopTailcatIdentity;
  return { nodeKey: yield* identity.nodeKey, encrypted: yield* identity.encrypted };
});

const withTempStateDirectory = <A, E, R>(
  use: (paths: {
    readonly baseDir: string;
    readonly identityDir: string;
    readonly tempDir: string;
    readonly encryptedPath: string;
    readonly plaintextPath: string;
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-tailcat-identity-" });
    // The desktop keeps packaged state under `<T3CODE_HOME>/userdata`.
    const identityDir = path.join(
      baseDir,
      "userdata",
      DesktopTailcatIdentity.DESKTOP_TAILCAT_IDENTITY_DIRECTORY,
    );
    return yield* use({
      baseDir,
      identityDir,
      tempDir: path.join(identityDir, "tmp"),
      encryptedPath: path.join(identityDir, "client-identity.enc"),
      plaintextPath: path.join(identityDir, "client-identity.private.json"),
    });
  }).pipe(Effect.provide(NodeServices.layer));

describe("DesktopTailcatIdentity", () => {
  it.effect("generates the identity once and stores it encrypted", () =>
    withTempStateDirectory((paths) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const generatedKeyPaths: Array<string> = [];
        const options = { encryptionAvailable: true, generatedKeyPaths };

        const first = yield* readIdentity.pipe(
          Effect.provide(makeIdentityLayer(paths.baseDir, options)),
        );

        assert.equal(first.nodeKey, NODE_KEY);
        assert.isTrue(first.encrypted);
        const [generatedKeyPath] = generatedKeyPaths;
        assert(generatedKeyPath !== undefined);
        assert.equal(generatedKeyPaths.length, 1);
        assert.equal(path.dirname(generatedKeyPath), paths.tempDir);
        assert.isFalse(yield* fileSystem.exists(generatedKeyPath));
        assert.isTrue(yield* fileSystem.exists(paths.encryptedPath));
        assert.isFalse(yield* fileSystem.exists(paths.plaintextPath));
        assert.deepEqual(yield* fileSystem.readDirectory(paths.tempDir), []);

        const stored = textDecoder.decode(yield* fileSystem.readFile(paths.encryptedPath));
        assert.isTrue(stored.startsWith(ENCRYPTED_PREFIX));
        const record = yield* decodeIdentityRecord(stored.slice(ENCRYPTED_PREFIX.length));
        assert.deepEqual(record, {
          version: 1,
          nodeKey: NODE_KEY,
          keyFile: KEY_FILE_TEXT,
          createdAt: EPOCH_ISO,
        });

        // A key file left behind by a crashed process is swept when the next instance starts.
        yield* fileSystem.writeFileString(path.join(paths.tempDir, "stale.key"), "privkey:stale");
        const second = yield* readIdentity.pipe(
          Effect.provide(makeIdentityLayer(paths.baseDir, options)),
        );

        assert.deepEqual(second, first);
        assert.equal(generatedKeyPaths.length, 1);
        assert.deepEqual(yield* fileSystem.readDirectory(paths.tempDir), []);
      }),
    ),
  );

  it.effect("materializes a private key file only for the duration of use", () =>
    withTempStateDirectory((paths) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const identity = yield* DesktopTailcatIdentity.DesktopTailcatIdentity;

        const observed = yield* identity.withKeyFile((keyPath) =>
          Effect.gen(function* () {
            const info = yield* fileSystem.stat(keyPath);
            return {
              keyPath,
              contents: yield* fileSystem.readFileString(keyPath),
              mode: info.mode & 0o777,
            };
          }),
        );

        assert.equal(path.dirname(observed.keyPath), paths.tempDir);
        assert.equal(observed.contents, KEY_FILE_TEXT);
        assert.equal(observed.mode, 0o600);
        assert.isFalse(yield* fileSystem.exists(observed.keyPath));

        const failure = yield* identity
          .withKeyFile((keyPath) => Effect.fail({ _tag: "UseFailed" as const, keyPath }))
          .pipe(Effect.flip);

        assert(failure._tag === "UseFailed");
        assert.notEqual(failure.keyPath, observed.keyPath);
        assert.isFalse(yield* fileSystem.exists(failure.keyPath));
        assert.deepEqual(yield* fileSystem.readDirectory(paths.tempDir), []);
      }).pipe(
        Effect.provide(
          makeIdentityLayer(paths.baseDir, { encryptionAvailable: true, generatedKeyPaths: [] }),
        ),
      ),
    ),
  );

  it.effect("falls back to a private plaintext file when OS encryption is unavailable", () =>
    withTempStateDirectory((paths) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const generatedKeyPaths: Array<string> = [];
        const options = { encryptionAvailable: false, generatedKeyPaths };

        const first = yield* readIdentity.pipe(
          Effect.provide(makeIdentityLayer(paths.baseDir, options)),
        );

        assert.equal(first.nodeKey, NODE_KEY);
        assert.isFalse(first.encrypted);
        assert.isFalse(yield* fileSystem.exists(paths.encryptedPath));
        assert.isTrue(yield* fileSystem.exists(paths.plaintextPath));
        const info = yield* fileSystem.stat(paths.plaintextPath);
        assert.equal(info.mode & 0o777, 0o600);
        const record = yield* decodeIdentityRecord(
          yield* fileSystem.readFileString(paths.plaintextPath),
        );
        assert.equal(record.nodeKey, NODE_KEY);
        assert.equal(record.keyFile, KEY_FILE_TEXT);

        const second = yield* readIdentity.pipe(
          Effect.provide(makeIdentityLayer(paths.baseDir, options)),
        );

        assert.deepEqual(second, first);
        assert.equal(generatedKeyPaths.length, 1);
      }),
    ),
  );
});
