// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no AES-GCM.
import * as NodeCrypto from "node:crypto";
import * as NodeModule from "node:module";

import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";

const secretStoreErrorContext = {
  resource: Schema.String,
  cause: Schema.Defect(),
};

export class SecretStoreSecureError extends Schema.TaggedError<SecretStoreSecureError>()(
  "SecretStoreSecureError",
  {
    ...secretStoreErrorContext,
  },
) {
  override get message(): string {
    return `Failed to secure ${this.resource}.`;
  }
}

export class SecretStoreReadError extends Schema.TaggedError<SecretStoreReadError>()(
  "SecretStoreReadError",
  {
    ...secretStoreErrorContext,
  },
) {
  override get message(): string {
    return `Failed to read ${this.resource}.`;
  }
}

export class SecretStoreTemporaryPathError extends Schema.TaggedError<SecretStoreTemporaryPathError>()(
  "SecretStoreTemporaryPathError",
  {
    ...secretStoreErrorContext,
  },
) {
  override get message(): string {
    return `Failed to create temporary path for ${this.resource}.`;
  }
}

export class SecretStorePersistError extends Schema.TaggedError<SecretStorePersistError>()(
  "SecretStorePersistError",
  {
    ...secretStoreErrorContext,
  },
) {
  override get message(): string {
    return `Failed to persist ${this.resource}.`;
  }
}

export class SecretStoreRandomGenerationError extends Schema.TaggedError<SecretStoreRandomGenerationError>()(
  "SecretStoreRandomGenerationError",
  {
    ...secretStoreErrorContext,
  },
) {
  override get message(): string {
    return `Failed to generate random bytes for ${this.resource}.`;
  }
}

export class SecretStoreConcurrentReadError extends Schema.TaggedError<SecretStoreConcurrentReadError>()(
  "SecretStoreConcurrentReadError",
  {
    resource: Schema.String,
  },
) {
  override get message(): string {
    return `Failed to read ${this.resource} after concurrent creation.`;
  }
}

export class SecretStoreRemoveError extends Schema.TaggedError<SecretStoreRemoveError>()(
  "SecretStoreRemoveError",
  {
    ...secretStoreErrorContext,
  },
) {
  override get message(): string {
    return `Failed to remove ${this.resource}.`;
  }
}

export class SecretStoreDecodeError extends Schema.TaggedError<SecretStoreDecodeError>()(
  "SecretStoreDecodeError",
  {
    ...secretStoreErrorContext,
  },
) {
  override get message(): string {
    return `Failed to decode ${this.resource}.`;
  }
}

export class SecretStoreEncodeError extends Schema.TaggedError<SecretStoreEncodeError>()(
  "SecretStoreEncodeError",
  {
    ...secretStoreErrorContext,
  },
) {
  override get message(): string {
    return `Failed to encode ${this.resource}.`;
  }
}

export class SecretStoreKeyringError extends Schema.TaggedError<SecretStoreKeyringError>()(
  "SecretStoreKeyringError",
  {
    ...secretStoreErrorContext,
  },
) {
  override get message(): string {
    return `Failed to use the OS keyring for ${this.resource}.`;
  }
}

export const SecretStoreError = Schema.Union([
  SecretStoreSecureError,
  SecretStoreReadError,
  SecretStoreTemporaryPathError,
  SecretStorePersistError,
  SecretStoreRandomGenerationError,
  SecretStoreConcurrentReadError,
  SecretStoreRemoveError,
  SecretStoreDecodeError,
  SecretStoreEncodeError,
  SecretStoreKeyringError,
]);
export type SecretStoreError = typeof SecretStoreError.Type;
export const isSecretStoreError = Schema.is(SecretStoreError);

const isPlatformError = (value: unknown): value is PlatformError.PlatformError =>
  Predicate.isTagged(value, "PlatformError");

export const isSecretAlreadyExistsError = (error: SecretStoreError): boolean =>
  "cause" in error && isPlatformError(error.cause) && error.cause.reason._tag === "AlreadyExists";

const KEYRING_SERVICE = "T3 Code";
// A locked Secret Service or an unanswered Keychain prompt can block indefinitely.
const KEYRING_TIMEOUT = Duration.seconds(30);
const KEYRING_KEY_BYTES = 32;
// Names the keyring entry that holds this directory's key; not a `.bin`, so sweeps skip it.
const KEYRING_ID_FILE = "keyring-id";

const requireForKeyring = NodeModule.createRequire(import.meta.url);

export class SecretStoreKeyring extends Context.Service<
  SecretStoreKeyring,
  {
    readonly get: (
      account: string,
    ) => Effect.Effect<Option.Option<Uint8Array>, SecretStoreKeyringError>;
    readonly set: (
      account: string,
      value: Uint8Array,
    ) => Effect.Effect<void, SecretStoreKeyringError>;
    readonly remove: (account: string) => Effect.Effect<void, SecretStoreKeyringError>;
  }
>()("t3/auth/ServerSecretStore/SecretStoreKeyring") {}

const useKeyringEntry = <A>(
  account: string,
  use: (entry: import("@napi-rs/keyring").AsyncEntry, signal: AbortSignal) => Promise<A>,
) =>
  Effect.tryPromise({
    try: (signal) => {
      // Loaded lazily so stores that never use the keyring never load the native binding.
      const { AsyncEntry } = requireForKeyring(
        "@napi-rs/keyring",
      ) as typeof import("@napi-rs/keyring");
      return use(new AsyncEntry(KEYRING_SERVICE, account), signal);
    },
    catch: (cause) => new SecretStoreKeyringError({ resource: `keyring entry ${account}`, cause }),
  }).pipe(
    Effect.timeoutOrElse({
      duration: KEYRING_TIMEOUT,
      orElse: () =>
        Effect.fail(
          new SecretStoreKeyringError({
            resource: `keyring entry ${account}`,
            cause: "Timed out waiting for the OS keyring.",
          }),
        ),
    }),
  );

export const layerNativeKeyring = Layer.succeed(
  SecretStoreKeyring,
  SecretStoreKeyring.of({
    get: Effect.fn("SecretStoreKeyring.get")(function* (account) {
      const secret = yield* useKeyringEntry(account, (entry, signal) => entry.getSecret(signal));
      // The binding resolves a plain number[] despite its Uint8Array typing.
      return Option.map(Option.fromNullishOr(secret), (bytes) => Uint8Array.from(bytes));
    }),
    set: Effect.fn("SecretStoreKeyring.set")(function* (account, value) {
      yield* useKeyringEntry(account, (entry, signal) => entry.setSecret(value, signal));
    }),
    remove: Effect.fn("SecretStoreKeyring.remove")(function* (account) {
      yield* useKeyringEntry(account, (entry, signal) => entry.deleteCredential(signal));
    }),
  }),
);

// Starts with NUL so no plaintext secret the file backend wrote can look encrypted.
const ENCRYPTED_HEADER = Buffer.from("\0t3-secret-v1\0");
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

const isEncrypted = (bytes: Uint8Array) =>
  bytes.length >= ENCRYPTED_HEADER.length + IV_BYTES + AUTH_TAG_BYTES &&
  ENCRYPTED_HEADER.equals(bytes.subarray(0, ENCRYPTED_HEADER.length));

// The secret name is bound as associated data so a file renamed to another secret fails to decrypt.
const encrypt = (key: Uint8Array, name: string, value: Uint8Array): Uint8Array => {
  const iv = NodeCrypto.randomBytes(IV_BYTES);
  const cipher = NodeCrypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(name));
  const body = Buffer.concat([cipher.update(value), cipher.final()]);
  return Buffer.concat([ENCRYPTED_HEADER, iv, cipher.getAuthTag(), body]);
};

const decrypt = (key: Uint8Array, name: string, bytes: Uint8Array): Uint8Array => {
  const ivStart = ENCRYPTED_HEADER.length;
  const tagStart = ivStart + IV_BYTES;
  const bodyStart = tagStart + AUTH_TAG_BYTES;
  const decipher = NodeCrypto.createDecipheriv(
    "aes-256-gcm",
    key,
    bytes.subarray(ivStart, tagStart),
  );
  decipher.setAAD(Buffer.from(name));
  decipher.setAuthTag(bytes.subarray(tagStart, bodyStart));
  return Uint8Array.from(
    Buffer.concat([decipher.update(bytes.subarray(bodyStart)), decipher.final()]),
  );
};

export class ServerSecretStore extends Context.Service<
  ServerSecretStore,
  {
    readonly directory?: string;
    readonly get: (name: string) => Effect.Effect<Option.Option<Uint8Array>, SecretStoreError>;
    readonly set: (name: string, value: Uint8Array) => Effect.Effect<void, SecretStoreError>;
    readonly create: (name: string, value: Uint8Array) => Effect.Effect<void, SecretStoreError>;
    readonly getOrCreateRandom: (
      name: string,
      bytes: number,
    ) => Effect.Effect<Uint8Array, SecretStoreError>;
    readonly remove: (name: string) => Effect.Effect<void, SecretStoreError>;
  }
>()("t3/auth/ServerSecretStore") {}

/** @public */
export const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const keyring = yield* SecretStoreKeyring;
  const { secretsDir } = serverConfig;

  yield* fileSystem.makeDirectory(secretsDir, { recursive: true });
  yield* fileSystem.chmod(secretsDir, 0o700).pipe(
    Effect.mapError(
      (cause) =>
        new SecretStoreSecureError({
          resource: `secrets directory ${secretsDir}`,
          cause,
        }),
    ),
  );

  const resolveSecretPath = (name: string) => path.join(secretsDir, `${name}.bin`);
  const keyringIdPath = path.join(secretsDir, KEYRING_ID_FILE);
  // Hashing the directory in keeps a copied secrets directory from reading or deleting this key.
  const directoryHash = NodeCrypto.createHash("sha256")
    .update(path.resolve(secretsDir))
    .digest("hex")
    .slice(0, 16);
  const keyringAccount = (id: string) => `${directoryHash}-${id}`;

  const readSecretFile = (name: string) =>
    fileSystem.readFile(resolveSecretPath(name)).pipe(
      Effect.map((bytes) => Option.some(Uint8Array.from(bytes))),
      Effect.catch((cause) =>
        cause.reason._tag === "NotFound"
          ? Effect.succeedNone
          : Effect.fail(
              new SecretStoreReadError({
                resource: `secret ${name}`,
                cause,
              }),
            ),
      ),
    );

  const writeSecretFile = (name: string, value: Uint8Array) => {
    const secretPath = resolveSecretPath(name);
    return crypto.randomUUIDv4().pipe(
      Effect.mapError(
        (cause) =>
          new SecretStoreTemporaryPathError({
            resource: `secret ${name}`,
            cause,
          }),
      ),
      Effect.flatMap((uuid) => {
        const tempPath = `${secretPath}.${uuid}.tmp`;
        return Effect.gen(function* () {
          yield* fileSystem.writeFile(tempPath, value);
          yield* fileSystem.chmod(tempPath, 0o600);
          yield* fileSystem.rename(tempPath, secretPath);
          yield* fileSystem.chmod(secretPath, 0o600);
        }).pipe(
          Effect.catch((cause) =>
            fileSystem.remove(tempPath).pipe(
              Effect.ignore,
              Effect.flatMap(() =>
                Effect.fail(
                  new SecretStorePersistError({
                    resource: `secret ${name}`,
                    cause,
                  }),
                ),
              ),
            ),
          ),
        );
      }),
    );
  };

  // `link` publishes the fully written temp file under the final name, or fails with
  // AlreadyExists, so a concurrent reader never observes a partially written file.
  const publishExclusive = (targetPath: string, resource: string, value: Uint8Array) =>
    crypto.randomUUIDv4().pipe(
      Effect.mapError((cause) => new SecretStoreTemporaryPathError({ resource, cause })),
      Effect.flatMap((uuid) => {
        const tempPath = `${targetPath}.${uuid}.tmp`;
        return Effect.gen(function* () {
          yield* Effect.scoped(
            Effect.gen(function* () {
              const file = yield* fileSystem.open(tempPath, { flag: "wx", mode: 0o600 });
              yield* file.writeAll(value);
              yield* file.sync;
            }),
          );
          yield* fileSystem.chmod(tempPath, 0o600);
          yield* fileSystem.link(tempPath, targetPath);
        }).pipe(
          Effect.ensuring(fileSystem.remove(tempPath).pipe(Effect.ignore)),
          Effect.mapError((cause) => new SecretStorePersistError({ resource, cause })),
        );
      }),
    );

  const readKeyringId = fileSystem.readFileString(keyringIdPath).pipe(
    Effect.map((id) => Option.some(id.trim())),
    Effect.catch((cause) =>
      cause.reason._tag === "NotFound"
        ? Effect.succeedNone
        : Effect.fail(new SecretStoreReadError({ resource: "secret store keyring id", cause })),
    ),
  );

  const loadKey = (id: string) =>
    keyring.get(keyringAccount(id)).pipe(
      Effect.filterOrFail(
        (key): key is Option.Some<Uint8Array> =>
          Option.isSome(key) && key.value.length === KEYRING_KEY_BYTES,
        () =>
          new SecretStoreKeyringError({
            resource: `secret store key ${keyringAccount(id)}`,
            cause: `The key is missing from the OS keyring. Remove ${secretsDir} to start over.`,
          }),
      ),
      Effect.map((key) => key.value),
    );

  const rewriteSecretFiles = (
    transform: (
      name: string,
      bytes: Uint8Array,
    ) => Effect.Effect<Option.Option<Uint8Array>, SecretStoreError>,
  ) =>
    fileSystem.readDirectory(secretsDir).pipe(
      Effect.mapError(
        (cause) => new SecretStoreReadError({ resource: `secrets directory ${secretsDir}`, cause }),
      ),
      Effect.flatMap((files) =>
        Effect.forEach(
          files.flatMap((file) => (file.endsWith(".bin") ? [file.slice(0, -".bin".length)] : [])),
          (name) =>
            readSecretFile(name).pipe(
              Effect.flatMap((bytes) =>
                Option.isNone(bytes) ? Effect.succeedNone : transform(name, bytes.value),
              ),
              Effect.flatMap((next) =>
                Option.isNone(next) ? Effect.void : writeSecretFile(name, next.value),
              ),
            ),
          { discard: true },
        ),
      ),
    );

  const enableKeyring = Effect.gen(function* () {
    const key = yield* crypto.randomBytes(KEYRING_KEY_BYTES);
    const id = yield* crypto.randomUUIDv4();
    yield* keyring.set(keyringAccount(id), key);
    const published = yield* publishExclusive(
      keyringIdPath,
      "secret store keyring id",
      new TextEncoder().encode(id),
    ).pipe(
      Effect.as(true),
      Effect.catchIf(isSecretAlreadyExistsError, () => Effect.succeed(false)),
    );
    if (!published) {
      // Another process enabled the keyring first; use its key.
      yield* keyring.remove(keyringAccount(id)).pipe(Effect.ignore);
      const winner = yield* readKeyringId;
      if (Option.isNone(winner)) {
        return yield* new SecretStoreConcurrentReadError({ resource: "secret store keyring id" });
      }
      return yield* loadKey(winner.value);
    }
    yield* rewriteSecretFiles((name, bytes) =>
      Effect.succeed(isEncrypted(bytes) ? Option.none() : Option.some(encrypt(key, name, bytes))),
    ).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Some secrets could not be moved under the keyring key", { cause }),
      ),
    );
    return Uint8Array.from(key);
  }).pipe(
    Effect.mapError((cause) =>
      isSecretStoreError(cause)
        ? cause
        : new SecretStoreRandomGenerationError({ resource: "secret store key", cause }),
    ),
  );

  const disableKeyring = Effect.fn("ServerSecretStore.disableKeyring")(function* (id: string) {
    const key = yield* loadKey(id);
    yield* rewriteSecretFiles((name, bytes) =>
      isEncrypted(bytes)
        ? Effect.try({
            try: () => Option.some(decrypt(key, name, bytes)),
            catch: (cause) => new SecretStoreDecodeError({ resource: `secret ${name}`, cause }),
          })
        : Effect.succeedNone,
    );
    yield* fileSystem
      .remove(keyringIdPath)
      .pipe(
        Effect.mapError(
          (cause) => new SecretStoreRemoveError({ resource: "secret store keyring id", cause }),
        ),
      );
    yield* keyring.remove(keyringAccount(id)).pipe(Effect.ignore);
  });

  // `secretStore` only switches backends; when unset, every process follows the keyring id file,
  // so CLI commands sharing a desktop home read what the desktop server wrote.
  const keyringId = yield* readKeyringId;
  const key: Uint8Array | undefined = Option.isSome(keyringId)
    ? serverConfig.secretStore === "file"
      ? yield* disableKeyring(keyringId.value).pipe(Effect.as(undefined))
      : yield* loadKey(keyringId.value)
    : serverConfig.secretStore === "keyring"
      ? yield* enableKeyring.pipe(
          Effect.catch((cause) =>
            Effect.logWarning("OS keyring unavailable; secrets stay in plaintext files", {
              cause,
            }).pipe(Effect.as(undefined)),
          ),
        )
      : undefined;

  const encode = (name: string, value: Uint8Array) =>
    key === undefined ? value : encrypt(key, name, value);

  const decode = (name: string, bytes: Uint8Array): Effect.Effect<Uint8Array, SecretStoreError> => {
    if (!isEncrypted(bytes)) return Effect.succeed(bytes);
    if (key === undefined) {
      return Effect.fail(
        new SecretStoreKeyringError({
          resource: `secret ${name}`,
          cause: "The secret is encrypted but this secrets directory has no keyring key.",
        }),
      );
    }
    return Effect.try({
      try: () => decrypt(key, name, bytes),
      catch: (cause) => new SecretStoreDecodeError({ resource: `secret ${name}`, cause }),
    });
  };

  const get: ServerSecretStore["Service"]["get"] = (name) =>
    readSecretFile(name).pipe(
      Effect.flatMap((bytes) =>
        Option.isNone(bytes) ? Effect.succeedNone : decode(name, bytes.value).pipe(Effect.asSome),
      ),
      Effect.withSpan("ServerSecretStore.get"),
    );

  const set: ServerSecretStore["Service"]["set"] = (name, value) =>
    Effect.suspend(() => writeSecretFile(name, encode(name, value))).pipe(
      Effect.withSpan("ServerSecretStore.set"),
    );

  const create: ServerSecretStore["Service"]["create"] = (name, value) =>
    Effect.suspend(() =>
      publishExclusive(resolveSecretPath(name), `secret ${name}`, encode(name, value)),
    );

  const getOrCreateRandom: ServerSecretStore["Service"]["getOrCreateRandom"] = (name, bytes) =>
    get(name).pipe(
      Effect.flatMap(
        Option.match({
          onSome: Effect.succeed,
          onNone: () =>
            crypto.randomBytes(bytes).pipe(
              Effect.mapError(
                (cause) =>
                  new SecretStoreRandomGenerationError({
                    resource: `secret ${name}`,
                    cause,
                  }),
              ),
              Effect.flatMap((generated) =>
                create(name, generated).pipe(
                  Effect.as(Uint8Array.from(generated)),
                  Effect.catchIf(isSecretStoreError, (error) =>
                    isSecretAlreadyExistsError(error)
                      ? get(name).pipe(
                          Effect.flatMap(
                            Option.match({
                              onSome: Effect.succeed,
                              onNone: () =>
                                Effect.fail(
                                  new SecretStoreConcurrentReadError({
                                    resource: `secret ${name}`,
                                  }),
                                ),
                            }),
                          ),
                        )
                      : Effect.fail(error),
                  ),
                ),
              ),
            ),
        }),
      ),
      Effect.withSpan("ServerSecretStore.getOrCreateRandom"),
    );

  const remove: ServerSecretStore["Service"]["remove"] = (name) =>
    fileSystem.remove(resolveSecretPath(name)).pipe(
      Effect.catch((cause) =>
        cause.reason._tag === "NotFound"
          ? Effect.void
          : Effect.fail(
              new SecretStoreRemoveError({
                resource: `secret ${name}`,
                cause,
              }),
            ),
      ),
      Effect.withSpan("ServerSecretStore.remove"),
    );

  return ServerSecretStore.of({
    directory: secretsDir,
    get,
    set,
    create,
    getOrCreateRandom,
    remove,
  });
});

export const layer = Layer.effect(ServerSecretStore, make).pipe(Layer.provide(layerNativeKeyring));
