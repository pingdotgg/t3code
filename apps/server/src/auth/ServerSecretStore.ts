import * as Crypto from "node:crypto";

import { Context, Data, Effect, FileSystem, Layer, Option, Path, Predicate } from "effect";
import * as PlatformError from "effect/PlatformError";

import { ServerConfig } from "../config.ts";

export class SecretStorePersistError extends Data.TaggedError("SecretStorePersistError")<{
  readonly resource: string;
  readonly cause?: unknown;
}> {}

export class SecretStoreReadError extends Data.TaggedError("SecretStoreReadError")<{
  readonly resource: string;
  readonly cause?: unknown;
}> {}

export class SecretStoreDecodeError extends Data.TaggedError("SecretStoreDecodeError")<{
  readonly resource: string;
  readonly cause?: unknown;
}> {}

export class SecretStoreEncodeError extends Data.TaggedError("SecretStoreEncodeError")<{
  readonly resource: string;
  readonly cause?: unknown;
}> {}

export class SecretStoreConcurrentReadError extends Data.TaggedError(
  "SecretStoreConcurrentReadError",
)<{
  readonly resource: string;
}> {}

export type SecretStoreError =
  | SecretStorePersistError
  | SecretStoreReadError
  | SecretStoreDecodeError
  | SecretStoreEncodeError
  | SecretStoreConcurrentReadError;

export function isSecretStoreError(error: unknown): error is SecretStoreError {
  return (
    Predicate.isTagged(error, "SecretStorePersistError") ||
    Predicate.isTagged(error, "SecretStoreReadError") ||
    Predicate.isTagged(error, "SecretStoreDecodeError") ||
    Predicate.isTagged(error, "SecretStoreEncodeError") ||
    Predicate.isTagged(error, "SecretStoreConcurrentReadError")
  );
}

export function isSecretAlreadyExistsError(error: SecretStoreError): boolean {
  const isPlatformError = (cause: unknown): cause is PlatformError.PlatformError =>
    Predicate.isTagged(cause, "PlatformError");
  return (
    error._tag === "SecretStorePersistError" &&
    isPlatformError(error.cause) &&
    error.cause.reason._tag === "AlreadyExists"
  );
}

export interface ServerSecretStoreShape {
  readonly get: (name: string) => Effect.Effect<Option.Option<Uint8Array>, SecretStoreReadError>;
  readonly set: (name: string, value: Uint8Array) => Effect.Effect<void, SecretStorePersistError>;
  readonly create: (
    name: string,
    value: Uint8Array,
  ) => Effect.Effect<void, SecretStorePersistError>;
  readonly getOrCreateRandom: (
    name: string,
    bytes: number,
  ) => Effect.Effect<Uint8Array, SecretStoreReadError | SecretStorePersistError>;
  readonly remove: (name: string) => Effect.Effect<void, SecretStorePersistError>;
  readonly list: () => Effect.Effect<ReadonlyArray<string>, SecretStoreReadError>;
}

export class ServerSecretStore extends Context.Service<ServerSecretStore, ServerSecretStoreShape>()(
  "t3/auth/ServerSecretStore",
) {}

export const layer = Layer.effect(
  ServerSecretStore,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const serverConfig = yield* ServerConfig;

    yield* fileSystem.makeDirectory(serverConfig.secretsDir, { recursive: true });
    yield* fileSystem.chmod(serverConfig.secretsDir, 0o700).pipe(
      Effect.mapError(
        (cause) =>
          new SecretStorePersistError({
            resource: serverConfig.secretsDir,
            cause,
          }),
      ),
    );

    const resolveSecretPath = (name: string) => path.join(serverConfig.secretsDir, `${name}.bin`);

    const get: ServerSecretStoreShape["get"] = (name) =>
      fileSystem.readFile(resolveSecretPath(name)).pipe(
        Effect.map((bytes) => Option.some(Uint8Array.from(bytes))),
        Effect.catch((cause) =>
          cause.reason._tag === "NotFound"
            ? Effect.succeed(Option.none())
            : Effect.fail(
                new SecretStoreReadError({
                  resource: name,
                  cause,
                }),
              ),
        ),
      );

    const set: ServerSecretStoreShape["set"] = (name, value) => {
      const secretPath = resolveSecretPath(name);
      const tempPath = `${secretPath}.${Crypto.randomUUID()}.tmp`;
      return Effect.gen(function* () {
        yield* fileSystem.writeFile(tempPath, value);
        yield* fileSystem.chmod(tempPath, 0o600);
        yield* fileSystem.rename(tempPath, secretPath);
        yield* fileSystem.chmod(secretPath, 0o600);
      }).pipe(
        Effect.catch((cause) =>
          Effect.gen(function* () {
            yield* fileSystem.remove(tempPath).pipe(Effect.ignore);
            return yield* new SecretStorePersistError({
              resource: name,
              cause,
            });
          }).pipe(
            Effect.annotateLogs({
              secret: name,
            }),
          ),
        ),
      );
    };

    const create: ServerSecretStoreShape["create"] = (name, value) =>
      Effect.scoped(
        Effect.gen(function* () {
          const file = yield* fileSystem.open(resolveSecretPath(name), {
            flag: "wx",
            mode: 0o600,
          });
          yield* file.writeAll(value);
          yield* file.sync;
          yield* fileSystem.chmod(resolveSecretPath(name), 0o600);
        }),
      ).pipe(
        Effect.mapError(
          (cause) =>
            new SecretStorePersistError({
              resource: name,
              cause,
            }),
        ),
      );

    const getOrCreateRandom: ServerSecretStoreShape["getOrCreateRandom"] = (name, bytes) =>
      get(name).pipe(
        Effect.flatMap(
          Option.match({
            onSome: Effect.succeed,
            onNone: () => {
              const generated = Uint8Array.from(Crypto.randomBytes(bytes));
              return create(name, generated).pipe(
                Effect.as(generated),
                Effect.catchIf(isSecretAlreadyExistsError, () =>
                  get(name).pipe(
                    Effect.flatMap(
                      Option.match({
                        onSome: Effect.succeed,
                        onNone: () =>
                          Effect.fail(
                            new SecretStoreReadError({
                              resource: name,
                            }),
                          ),
                      }),
                    ),
                  ),
                ),
              );
            },
          }),
        ),
      );

    const remove: ServerSecretStoreShape["remove"] = (name) =>
      fileSystem.remove(resolveSecretPath(name)).pipe(
        Effect.catch((cause) =>
          cause.reason._tag === "NotFound"
            ? Effect.void
            : Effect.fail(
                new SecretStorePersistError({
                  resource: name,
                  cause,
                }),
              ),
        ),
      );

    const list: ServerSecretStoreShape["list"] = () =>
      fileSystem.readDirectory(serverConfig.secretsDir).pipe(
        Effect.map((entries) =>
          entries
            .filter((entry) => entry.endsWith(".bin"))
            .map((entry) => entry.slice(0, -".bin".length)),
        ),
        Effect.catch((cause) =>
          Effect.fail(
            new SecretStoreReadError({
              resource: serverConfig.secretsDir,
              cause,
            }),
          ),
        ),
      );

    return { get, set, create, getOrCreateRandom, remove, list } satisfies ServerSecretStoreShape;
  }),
);
