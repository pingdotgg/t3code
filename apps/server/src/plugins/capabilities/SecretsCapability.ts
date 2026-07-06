import type { PluginId } from "@t3tools/contracts/plugin";
import type { SecretsCapability } from "@t3tools/plugin-sdk";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";

import * as ServerConfig from "../../config.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";

const keyPrefix = (pluginId: PluginId) => `plugin:${pluginId}:`;

// The backing store maps keys to file paths verbatim, so secret names must
// be a safe path segment: no separators, no dots-only tricks, no colons
// (colons delimit the plugin prefix and break list() parsing).
const SECRET_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export class PluginSecretNameError extends Schema.TaggedErrorClass<PluginSecretNameError>()(
  "PluginSecretNameError",
  { name: Schema.String },
) {
  override get message(): string {
    return `Invalid secret name ${JSON.stringify(this.name)}: names must match ${SECRET_NAME_PATTERN.source}.`;
  }
}

export function makeSecretsCapability(input: {
  readonly pluginId: PluginId;
  readonly store: ServerSecretStore.ServerSecretStore["Service"];
  readonly config: ServerConfig.ServerConfig["Service"];
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
}): SecretsCapability {
  const prefix = keyPrefix(input.pluginId);
  const scoped = (name: string): Effect.Effect<string, PluginSecretNameError> =>
    SECRET_NAME_PATTERN.test(name)
      ? Effect.succeed(`${prefix}${name}`)
      : Effect.fail(new PluginSecretNameError({ name }));

  return {
    get: (name) =>
      scoped(name).pipe(
        Effect.flatMap((key) => input.store.get(key)),
        Effect.map(
          Option.match({
            onNone: () => null,
            onSome: (value) => value,
          }),
        ),
      ),
    set: (name, value) => scoped(name).pipe(Effect.flatMap((key) => input.store.set(key, value))),
    delete: (name) => scoped(name).pipe(Effect.flatMap((key) => input.store.remove(key))),
    list: input.fileSystem.readDirectory(input.config.secretsDir).pipe(
      Effect.map((entries) =>
        entries
          .filter((entry) => entry.endsWith(".bin"))
          .map((entry) => entry.slice(0, -".bin".length))
          .filter((name) => name.startsWith(prefix))
          .map((name) => name.slice(prefix.length))
          .sort(),
      ),
      Effect.catch((cause) =>
        cause.reason._tag === "NotFound" ? Effect.succeed([]) : Effect.fail(cause),
      ),
    ),
  };
}
