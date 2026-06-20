import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";

const storedSecretErrorContext = {
  secretName: Schema.String,
  secretPath: Schema.String,
  cause: Schema.Defect(),
};

export class SecretStoreDirectoryCreateError extends Schema.TaggedErrorClass<SecretStoreDirectoryCreateError>()(
  "SecretStoreDirectoryCreateError",
  {
    directoryPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to create secret store directory ${this.directoryPath}.`;
  }
}

export class SecretStoreDirectorySecureError extends Schema.TaggedErrorClass<SecretStoreDirectorySecureError>()(
  "SecretStoreDirectorySecureError",
  {
    directoryPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to secure secret store directory ${this.directoryPath}.`;
  }
}

export class SecretStoreReadError extends Schema.TaggedErrorClass<SecretStoreReadError>()(
  "SecretStoreReadError",
  {
    ...storedSecretErrorContext,
  },
) {
  override get message(): string {
    return `Failed to read secret ${this.secretName} at ${this.secretPath}.`;
  }
}

export class SecretStoreTemporaryPathGenerationError extends Schema.TaggedErrorClass<SecretStoreTemporaryPathGenerationError>()(
  "SecretStoreTemporaryPathGenerationError",
  {
    secretName: Schema.String,
    secretPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to generate a temporary path for secret ${this.secretName} at ${this.secretPath}.`;
  }
}

export class SecretStorePersistError extends Schema.TaggedErrorClass<SecretStorePersistError>()(
  "SecretStorePersistError",
  {
    operation: Schema.Literals(["create", "set"]),
    ...storedSecretErrorContext,
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} secret ${this.secretName} at ${this.secretPath}.`;
  }
}

export class SecretStoreRandomGenerationError extends Schema.TaggedErrorClass<SecretStoreRandomGenerationError>()(
  "SecretStoreRandomGenerationError",
  {
    secretName: Schema.String,
    byteCount: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to generate ${this.byteCount} random bytes for secret ${this.secretName}.`;
  }
}

export class SecretStoreConcurrentReadError extends Schema.TaggedErrorClass<SecretStoreConcurrentReadError>()(
  "SecretStoreConcurrentReadError",
  {
    secretName: Schema.String,
  },
) {
  override get message(): string {
    return `Failed to read secret ${this.secretName} after concurrent creation.`;
  }
}

export class SecretStoreRemoveError extends Schema.TaggedErrorClass<SecretStoreRemoveError>()(
  "SecretStoreRemoveError",
  {
    ...storedSecretErrorContext,
  },
) {
  override get message(): string {
    return `Failed to remove secret ${this.secretName} at ${this.secretPath}.`;
  }
}

export class SecretStoreDecodeError extends Schema.TaggedErrorClass<SecretStoreDecodeError>()(
  "SecretStoreDecodeError",
  {
    secretName: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to decode secret ${this.secretName}.`;
  }
}

export class SecretStoreEncodeError extends Schema.TaggedErrorClass<SecretStoreEncodeError>()(
  "SecretStoreEncodeError",
  {
    secretName: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to encode secret ${this.secretName}.`;
  }
}

export const SecretStoreError = Schema.Union([
  SecretStoreDirectoryCreateError,
  SecretStoreDirectorySecureError,
  SecretStoreReadError,
  SecretStoreTemporaryPathGenerationError,
  SecretStorePersistError,
  SecretStoreRandomGenerationError,
  SecretStoreConcurrentReadError,
  SecretStoreRemoveError,
  SecretStoreDecodeError,
  SecretStoreEncodeError,
]);
export type SecretStoreError = typeof SecretStoreError.Type;
export const isSecretStoreError = Schema.is(SecretStoreError);

const isPlatformError = (value: unknown): value is PlatformError.PlatformError =>
  Predicate.isTagged(value, "PlatformError");

export const isSecretAlreadyExistsError = (error: SecretStoreError): boolean =>
  "cause" in error && isPlatformError(error.cause) && error.cause.reason._tag === "AlreadyExists";

export class ServerSecretStore extends Context.Service<
  ServerSecretStore,
  {
    readonly get: (name: string) => Effect.Effect<Option.Option<Uint8Array>, SecretStoreReadError>;
    readonly set: (
      name: string,
      value: Uint8Array,
    ) => Effect.Effect<void, SecretStoreTemporaryPathGenerationError | SecretStorePersistError>;
    readonly create: (
      name: string,
      value: Uint8Array,
    ) => Effect.Effect<void, SecretStorePersistError>;
    readonly getOrCreateRandom: (
      name: string,
      bytes: number,
    ) => Effect.Effect<
      Uint8Array,
      | SecretStoreReadError
      | SecretStoreRandomGenerationError
      | SecretStorePersistError
      | SecretStoreConcurrentReadError
    >;
    readonly remove: (name: string) => Effect.Effect<void, SecretStoreRemoveError>;
  }
>()("t3/auth/ServerSecretStore") {}

export const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig.ServerConfig;

  yield* fileSystem.makeDirectory(serverConfig.secretsDir, { recursive: true }).pipe(
    Effect.mapError(
      (cause) =>
        new SecretStoreDirectoryCreateError({
          directoryPath: serverConfig.secretsDir,
          cause,
        }),
    ),
  );
  yield* fileSystem.chmod(serverConfig.secretsDir, 0o700).pipe(
    Effect.mapError(
      (cause) =>
        new SecretStoreDirectorySecureError({
          directoryPath: serverConfig.secretsDir,
          cause,
        }),
    ),
  );

  const resolveSecretPath = (name: string) => path.join(serverConfig.secretsDir, `${name}.bin`);

  const get: ServerSecretStore["Service"]["get"] = (name) => {
    const secretPath = resolveSecretPath(name);
    return fileSystem.readFile(secretPath).pipe(
      Effect.map((bytes) => Option.some(Uint8Array.from(bytes))),
      Effect.catch((cause) =>
        cause.reason._tag === "NotFound"
          ? Effect.succeed(Option.none())
          : Effect.fail(
              new SecretStoreReadError({
                secretName: name,
                secretPath,
                cause,
              }),
            ),
      ),
      Effect.withSpan("ServerSecretStore.get"),
    );
  };

  const set: ServerSecretStore["Service"]["set"] = (name, value) => {
    const secretPath = resolveSecretPath(name);
    return crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new SecretStoreTemporaryPathGenerationError({
            secretName: name,
            secretPath,
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
                    operation: "set",
                    secretName: name,
                    secretPath,
                    cause,
                  }),
                ),
              ),
            ),
          ),
        );
      }),
      Effect.withSpan("ServerSecretStore.set"),
    );
  };

  const create: ServerSecretStore["Service"]["create"] = (name, value) => {
    const secretPath = resolveSecretPath(name);
    return Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fileSystem.open(secretPath, {
          flag: "wx",
          mode: 0o600,
        });
        yield* file.writeAll(value);
        yield* file.sync;
        yield* fileSystem.chmod(secretPath, 0o600);
      }),
    ).pipe(
      Effect.mapError(
        (cause) =>
          new SecretStorePersistError({
            operation: "create",
            secretName: name,
            secretPath,
            cause,
          }),
      ),
    );
  };

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
                    secretName: name,
                    byteCount: bytes,
                    cause,
                  }),
              ),
              Effect.flatMap((generated) =>
                create(name, generated).pipe(
                  Effect.as(Uint8Array.from(generated)),
                  Effect.catchTags({
                    SecretStorePersistError: (error) =>
                      isSecretAlreadyExistsError(error)
                        ? get(name).pipe(
                            Effect.flatMap(
                              Option.match({
                                onSome: Effect.succeed,
                                onNone: () =>
                                  Effect.fail(
                                    new SecretStoreConcurrentReadError({
                                      secretName: name,
                                    }),
                                  ),
                              }),
                            ),
                          )
                        : Effect.fail(error),
                  }),
                ),
              ),
            ),
        }),
      ),
      Effect.withSpan("ServerSecretStore.getOrCreateRandom"),
    );

  const remove: ServerSecretStore["Service"]["remove"] = (name) => {
    const secretPath = resolveSecretPath(name);
    return fileSystem.remove(secretPath).pipe(
      Effect.catch((cause) =>
        cause.reason._tag === "NotFound"
          ? Effect.void
          : Effect.fail(
              new SecretStoreRemoveError({
                secretName: name,
                secretPath,
                cause,
              }),
            ),
      ),
      Effect.withSpan("ServerSecretStore.remove"),
    );
  };

  return ServerSecretStore.of({
    get,
    set,
    create,
    getOrCreateRandom,
    remove,
  });
});

export const layer = Layer.effect(ServerSecretStore, make);
