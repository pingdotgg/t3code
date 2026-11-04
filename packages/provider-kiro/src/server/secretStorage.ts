import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as EffectAcpErrors from "effect-acp/errors";

import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";

const SecretKey = Schema.Struct({ key: Schema.String });
const SecretEntry = Schema.Struct({ key: Schema.String, value: Schema.String });
const SecretsJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String), {
  space: 2,
});
type Secrets = typeof SecretsJson.Type;
const decodeSecrets = Schema.decodeUnknownEffect(SecretsJson);
const encodeSecrets = Schema.encodeSync(SecretsJson);

// Read-modify-write is serialized across every Kiro session in this server.
const secretsFileLock = Semaphore.makeUnsafe(1);

const secretStorageError = (cause: unknown) =>
  EffectAcpErrors.AcpRequestError.internalError("Kiro secret storage failed", undefined, { cause });

/** kiro-cli's own secrets file, so sessions reuse the MCP sign-ins it stored. */
const kiroSecretsPath = (
  path: Path.Path,
  environment: NodeJS.ProcessEnv,
  homeDirectory: string,
) => {
  const kiroHome = environment.KIRO_HOME?.trim();
  return kiroHome && path.isAbsolute(kiroHome)
    ? path.join(kiroHome, "secrets.json")
    : path.join(environment.HOME?.trim() || homeDirectory, ".kiro", "secrets.json");
};

/** Answers `_kiro/secret/*`, which Kiro sends once the client advertises `secretStorage`. */
export const makeKiroSecretStorage = Effect.fn("makeKiroSecretStorage")(function* (
  environment: NodeJS.ProcessEnv,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const secretsPath = kiroSecretsPath(path, environment, yield* HostProcess.HomeDirectory);

  // Only a missing file is empty: rewriting one we cannot read would drop kiro-cli's other sign-ins.
  const readUnlocked = fileSystem.readFileString(secretsPath).pipe(
    Effect.catchTags({
      PlatformError: (error) =>
        error.reason._tag === "NotFound" ? Effect.succeed("{}") : Effect.fail(error),
    }),
    Effect.flatMap(decodeSecrets),
  );

  const get = Effect.fn("KiroSecretStorage.get")(
    function* (key: string) {
      const secrets = yield* readUnlocked;
      return { value: Object.hasOwn(secrets, key) ? (secrets[key] ?? null) : null };
    },
    secretsFileLock.withPermits(1),
    Effect.orElseSucceed(() => ({ value: null })),
  );

  const update = Effect.fn("KiroSecretStorage.update")(
    function* (change: (secrets: Secrets) => Secrets) {
      const next = change(yield* readUnlocked);
      // Atomic, so a failed write cannot truncate the sign-ins kiro-cli keeps in the same file.
      yield* writeFileStringAtomically({
        filePath: secretsPath,
        contents: encodeSecrets(next),
        mode: 0o600,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.provideService(HostProcess.Platform, platform),
      );
      return { success: true } as const;
    },
    secretsFileLock.withPermits(1),
    Effect.mapError(secretStorageError),
  );

  const store = (key: string, value: string) => update((secrets) => ({ ...secrets, [key]: value }));
  const remove = (key: string) => update(({ [key]: _removed, ...rest }) => rest);

  // Installed before the runtime starts: Kiro reads secrets while `session/new` connects MCP servers.
  const installHandlers = (runtime: AcpSessionRuntime.AcpSessionRuntime["Service"]) =>
    Effect.all(
      [
        runtime.handleExtRequest("_kiro/secret/get", SecretKey, ({ key }) => get(key)),
        runtime.handleExtRequest("_kiro/secret/store", SecretEntry, ({ key, value }) =>
          store(key, value),
        ),
        runtime.handleExtRequest("_kiro/secret/delete", SecretKey, ({ key }) => remove(key)),
      ],
      { discard: true },
    );

  return { get, store, remove, installHandlers };
});
