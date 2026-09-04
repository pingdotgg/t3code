import { type TailcatNodeKey, tailcatNodeKeyFingerprint } from "@t3tools/contracts";
import * as TailcatRuntime from "@t3tools/tailcat/runtime";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";

/**
 * The desktop's Tailcat client identity: the private key T3 servers trust
 * after a connection code is redeemed. It is stored encrypted with Electron's
 * safeStorage (OS keychain / DPAPI / libsecret) and only materialized as a
 * 0600 temp file for the moments a `tailcat` process needs to read it.
 *
 * When the OS offers no encryption backend, the key falls back to a 0600
 * plaintext file inside the desktop state directory, which is still private to
 * the user account; the fallback is logged so support can see it.
 */

export const DESKTOP_TAILCAT_IDENTITY_DIRECTORY = "tailcat";
const ENCRYPTED_IDENTITY_FILE = "client-identity.enc";
const PLAINTEXT_IDENTITY_FILE = "client-identity.private.json";
const TEMP_DIRECTORY = "tmp";

const IdentityRecord = Schema.Struct({
  version: Schema.Literal(1),
  nodeKey: Schema.String,
  keyFile: Schema.String,
  createdAt: Schema.String,
});
type IdentityRecord = typeof IdentityRecord.Type;
const IdentityRecordJson = Schema.fromJsonString(IdentityRecord);
const decodeIdentityRecord = Schema.decodeUnknownEffect(IdentityRecordJson);
const encodeIdentityRecord = Schema.encodeEffect(IdentityRecordJson);

export class DesktopTailcatIdentityError extends Schema.TaggedErrorClass<DesktopTailcatIdentityError>()(
  "DesktopTailcatIdentityError",
  {
    operation: Schema.Literals(["load", "generate", "store", "materialize"]),
    detail: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Tailcat identity ${this.operation} failed: ${this.detail}`;
  }
}

export class DesktopTailcatIdentity extends Context.Service<
  DesktopTailcatIdentity,
  {
    /** Public node key of this device, generating the identity on first use. */
    readonly nodeKey: Effect.Effect<TailcatNodeKey, DesktopTailcatIdentityError>;
    /** Whether the private key is protected by the OS encryption backend. */
    readonly encrypted: Effect.Effect<boolean>;
    /**
     * Runs `use` with a temporary 0600 key file that is deleted afterwards,
     * whatever the outcome.
     */
    readonly withKeyFile: <A, E, R>(
      use: (keyPath: string) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | DesktopTailcatIdentityError, R>;
  }
>()("@t3tools/desktop/tailcat/DesktopTailcatIdentity") {}

const describe = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const safeStorage = yield* ElectronSafeStorage.ElectronSafeStorage;
  const runtime = yield* TailcatRuntime.TailcatRuntime;
  const crypto = yield* Crypto.Crypto;
  const lock = yield* Semaphore.make(1);

  const directory = path.join(environment.stateDir, DESKTOP_TAILCAT_IDENTITY_DIRECTORY);
  const tempDirectory = path.join(directory, TEMP_DIRECTORY);
  const encryptedPath = path.join(directory, ENCRYPTED_IDENTITY_FILE);
  const plaintextPath = path.join(directory, PLAINTEXT_IDENTITY_FILE);
  const cached = yield* Ref.make<Option.Option<{ record: IdentityRecord; encrypted: boolean }>>(
    Option.none(),
  );

  const ensureDirectories = Effect.gen(function* () {
    yield* fileSystem.makeDirectory(tempDirectory, { recursive: true }).pipe(Effect.ignore);
    yield* fileSystem.chmod(directory, 0o700).pipe(Effect.ignore);
    yield* fileSystem.chmod(tempDirectory, 0o700).pipe(Effect.ignore);
  });

  // Temp key files from a previous crash must not outlive the process that
  // needed them.
  const sweepTempFiles = fileSystem.readDirectory(tempDirectory).pipe(
    Effect.flatMap((entries) =>
      Effect.forEach(
        entries,
        (entry) => fileSystem.remove(path.join(tempDirectory, entry)).pipe(Effect.ignore),
        { discard: true },
      ),
    ),
    Effect.ignore,
  );
  yield* ensureDirectories;
  yield* sweepTempFiles;

  const encryptionAvailable = safeStorage.isEncryptionAvailable.pipe(
    Effect.orElseSucceed(() => false),
  );

  const readStored = Effect.gen(function* () {
    const encryptedExists = yield* fileSystem
      .exists(encryptedPath)
      .pipe(Effect.orElseSucceed(() => false));
    if (encryptedExists) {
      const bytes = yield* fileSystem.readFile(encryptedPath);
      const json = yield* safeStorage.decryptString(bytes);
      const record = yield* decodeIdentityRecord(json);
      return Option.some({ record, encrypted: true });
    }
    const plaintextExists = yield* fileSystem
      .exists(plaintextPath)
      .pipe(Effect.orElseSucceed(() => false));
    if (plaintextExists) {
      const json = yield* fileSystem.readFileString(plaintextPath);
      const record = yield* decodeIdentityRecord(json);
      return Option.some({ record, encrypted: false });
    }
    return Option.none<{ record: IdentityRecord; encrypted: boolean }>();
  }).pipe(
    Effect.mapError(
      (cause) =>
        new DesktopTailcatIdentityError({
          operation: "load",
          detail: describe(cause),
          cause,
        }),
    ),
  );

  const tempPath = crypto.randomUUIDv4.pipe(
    Effect.map((uuid) => path.join(tempDirectory, `${uuid.replace(/-/g, "")}.key`)),
    Effect.mapError(
      (cause) =>
        new DesktopTailcatIdentityError({
          operation: "materialize",
          detail: "Secure randomness is unavailable.",
          cause,
        }),
    ),
  );

  const writePrivate = (filePath: string, contents: string) =>
    fileSystem
      .writeFileString(filePath, contents, { mode: 0o600 })
      .pipe(Effect.andThen(fileSystem.chmod(filePath, 0o600).pipe(Effect.ignore)));

  const store = (record: IdentityRecord) =>
    Effect.gen(function* () {
      const json = yield* encodeIdentityRecord(record);
      if (yield* encryptionAvailable) {
        const bytes = yield* safeStorage.encryptString(json);
        yield* fileSystem.writeFile(encryptedPath, bytes, { mode: 0o600 });
        yield* fileSystem.chmod(encryptedPath, 0o600).pipe(Effect.ignore);
        yield* fileSystem.remove(plaintextPath).pipe(Effect.ignore);
        return true;
      }
      yield* Effect.logWarning(
        "OS encryption is unavailable; the Tailcat client identity is stored as a private file.",
        { path: plaintextPath },
      );
      yield* writePrivate(plaintextPath, json);
      return false;
    }).pipe(
      Effect.mapError(
        (cause) =>
          new DesktopTailcatIdentityError({
            operation: "store",
            detail: describe(cause),
            cause,
          }),
      ),
    );

  const generate = Effect.gen(function* () {
    const keyPath = yield* tempPath;
    const generated = yield* runtime.generateClientIdentity({ keyPath }).pipe(
      Effect.mapError(
        (cause) =>
          new DesktopTailcatIdentityError({
            operation: "generate",
            detail: cause.message,
            cause,
          }),
      ),
    );
    const keyFile = yield* fileSystem.readFileString(keyPath).pipe(
      Effect.mapError(
        (cause) =>
          new DesktopTailcatIdentityError({
            operation: "generate",
            detail: describe(cause),
            cause,
          }),
      ),
      Effect.ensuring(fileSystem.remove(keyPath).pipe(Effect.ignore)),
    );
    const record: IdentityRecord = {
      version: 1,
      nodeKey: generated.nodeKey,
      keyFile,
      createdAt: yield* DateTime.now.pipe(Effect.map(DateTime.formatIso)),
    };
    const encrypted = yield* store(record);
    yield* Effect.logInfo("Created the Tailcat client identity.", {
      nodeKeyFingerprint: tailcatNodeKeyFingerprint(generated.nodeKey),
      encrypted,
    });
    return { record, encrypted };
  });

  const load = lock.withPermits(1)(
    Effect.gen(function* () {
      const current = yield* Ref.get(cached);
      if (Option.isSome(current)) {
        return current.value;
      }
      const stored = yield* readStored;
      const identity = Option.isSome(stored) ? stored.value : yield* generate;
      yield* Ref.set(cached, Option.some(identity));
      return identity;
    }),
  );

  const withKeyFile: DesktopTailcatIdentity["Service"]["withKeyFile"] = (use) =>
    Effect.gen(function* () {
      const identity = yield* load;
      const keyPath = yield* tempPath;
      yield* writePrivate(keyPath, identity.record.keyFile).pipe(
        Effect.mapError(
          (cause) =>
            new DesktopTailcatIdentityError({
              operation: "materialize",
              detail: describe(cause),
              cause,
            }),
        ),
      );
      return yield* use(keyPath).pipe(
        Effect.ensuring(fileSystem.remove(keyPath).pipe(Effect.ignore)),
      );
    });

  return DesktopTailcatIdentity.of({
    nodeKey: load.pipe(Effect.map((identity) => identity.record.nodeKey as TailcatNodeKey)),
    encrypted: load.pipe(
      Effect.map((identity) => identity.encrypted),
      Effect.orElseSucceed(() => false),
    ),
    withKeyFile,
  });
});

export const layer = Layer.effect(DesktopTailcatIdentity, make);
