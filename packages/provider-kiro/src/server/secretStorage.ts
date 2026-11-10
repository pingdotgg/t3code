import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";

const SecretKey = Schema.Struct({ key: Schema.String });
const decodeSecrets = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
);

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

/**
 * Answers `_kiro/secret/get`, which Kiro sends once the client advertises `secretStorage`.
 * Read-only: kiro-cli rewrites this file without a lock, so a T3 write could drop its sign-ins.
 * `_kiro/secret/store` and `_kiro/secret/delete` stay unhandled (method not found).
 */
export const makeKiroSecretStorage = Effect.fn("makeKiroSecretStorage")(function* (
  environment: NodeJS.ProcessEnv,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const secretsPath = kiroSecretsPath(path, environment, yield* HostProcess.HomeDirectory);

  const get = Effect.fn("KiroSecretStorage.get")(
    function* (key: string) {
      const secrets = yield* fileSystem
        .readFileString(secretsPath)
        .pipe(Effect.flatMap(decodeSecrets));
      return { value: Object.hasOwn(secrets, key) ? (secrets[key] ?? null) : null };
    },
    Effect.orElseSucceed(() => ({ value: null })),
  );

  // Installed before the runtime starts: Kiro reads secrets while `session/new` connects MCP servers.
  const installHandlers = (runtime: AcpSessionRuntime.AcpSessionRuntime["Service"]) =>
    runtime.handleExtRequest("_kiro/secret/get", SecretKey, ({ key }) => get(key));

  return { get, installHandlers };
});
