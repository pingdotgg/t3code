import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as PlatformError from "effect/PlatformError";

import { ServerConfig } from "../config.ts";

export class SecretStoreError extends Data.TaggedError("SecretStoreError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface ServerSecretStoreShape {
  readonly get: (name: string) => Effect.Effect<Uint8Array | null, SecretStoreError>;
  readonly set: (name: string, value: Uint8Array) => Effect.Effect<void, SecretStoreError>;
  readonly getOrCreateRandom: (
    name: string,
    bytes: number,
  ) => Effect.Effect<Uint8Array, SecretStoreError>;
  readonly remove: (name: string) => Effect.Effect<void, SecretStoreError>;
}

export class ServerSecretStore extends Context.Service<ServerSecretStore, ServerSecretStoreShape>()(
  "t3/auth/ServerSecretStore",
) {}

export const make = Effect.fn("makeServerSecretStore")(function* () {
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig;

  yield* fileSystem.makeDirectory(serverConfig.secretsDir, { recursive: true });
  yield* fileSystem.chmod(serverConfig.secretsDir, 0o700).pipe(
    Effect.mapError(
      (cause) =>
        new SecretStoreError({
          message: `Failed to secure secrets directory ${serverConfig.secretsDir}.`,
          cause,
        }),
    ),
  );

  const resolveSecretPath = (name: string) => path.join(serverConfig.secretsDir, `${name}.bin`);

  const isPlatformError = (u: unknown): u is PlatformError.PlatformError =>
    Predicate.isTagged(u, "PlatformError");

  const get: ServerSecretStoreShape["get"] = (name) =>
    fileSystem.readFile(resolveSecretPath(name)).pipe(
      Effect.map((bytes) => Uint8Array.from(bytes)),
      Effect.catch((cause) =>
        cause.reason._tag === "NotFound"
          ? Effect.succeed(null)
          : Effect.fail(
              new SecretStoreError({
                message: `Failed to read secret ${name}.`,
                cause,
              }),
            ),
      ),
      Effect.withSpan("ServerSecretStore.get"),
    );

  const set: ServerSecretStoreShape["set"] = (name, value) => {
    const secretPath = resolveSecretPath(name);
    return crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new SecretStoreError({
            message: `Failed to create temporary path for secret ${name}.`,
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
                  new SecretStoreError({
                    message: `Failed to persist secret ${name}.`,
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

  const create: ServerSecretStoreShape["set"] = (name, value) => {
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
          new SecretStoreError({
            message: `Failed to persist secret ${name}.`,
            cause,
          }),
      ),
    );
  };

  const getOrCreateRandom: ServerSecretStoreShape["getOrCreateRandom"] = (name, bytes) =>
    get(name).pipe(
      Effect.flatMap((existing) => {
        if (existing) {
          return Effect.succeed(existing);
        }

        return crypto.randomBytes(bytes).pipe(
          Effect.mapError(
            (cause) =>
              new SecretStoreError({
                message: `Failed to generate random bytes for secret ${name}.`,
                cause,
              }),
          ),
          Effect.flatMap((generated) =>
            create(name, generated).pipe(
              Effect.as(Uint8Array.from(generated)),
              Effect.catchTag("SecretStoreError", (error) =>
                isPlatformError(error.cause) && error.cause.reason._tag === "AlreadyExists"
                  ? get(name).pipe(
                      Effect.flatMap((created) =>
                        created !== null
                          ? Effect.succeed(created)
                          : Effect.fail(
                              new SecretStoreError({
                                message: `Failed to read secret ${name} after concurrent creation.`,
                              }),
                            ),
                      ),
                    )
                  : Effect.fail(error),
              ),
            ),
          ),
        );
      }),
      Effect.withSpan("ServerSecretStore.getOrCreateRandom"),
    );

  const remove: ServerSecretStoreShape["remove"] = (name) =>
    fileSystem.remove(resolveSecretPath(name)).pipe(
      Effect.catch((cause) =>
        cause.reason._tag === "NotFound"
          ? Effect.void
          : Effect.fail(
              new SecretStoreError({
                message: `Failed to remove secret ${name}.`,
                cause,
              }),
            ),
      ),
      Effect.withSpan("ServerSecretStore.remove"),
    );

  return {
    get,
    set,
    getOrCreateRandom,
    remove,
  } satisfies ServerSecretStoreShape;
});

export const layer = Layer.effect(ServerSecretStore, make());
