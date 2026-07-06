import type { PluginId } from "@t3tools/contracts/plugin";
import type { SecretsCapability } from "@t3tools/plugin-sdk";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";

import * as ServerConfig from "../../config.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";

// The backing store maps keys to filenames verbatim (`<key>.bin`), and the
// server targets Windows where ':' is illegal in filenames. Delimit with '~',
// which is absent from both the plugin id charset ([a-z][a-z0-9-]{1,40}) and the
// secret name charset (SECRET_NAME_PATTERN below), so keys stay Windows-safe and
// list() can still split the prefix from the name unambiguously. Round-trips:
// set/get/delete build `plugin~<id>~<name>`; list() strips `plugin~<id>~` back.
const keyPrefix = (pluginId: PluginId) => `plugin~${pluginId}~`;

// The backing store maps keys to file paths verbatim, so secret names must
// be a safe path segment: no separators, no dots-only tricks, no '~'
// (the delimiter of the plugin prefix, which would break list() parsing).
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
        // Guard `.reason`: a non-SystemError-shaped failure has no `reason`, and
        // `undefined._tag` would throw a TypeError (an unhandled defect) inside
        // the catch instead of surfacing the original recoverable failure.
        cause.reason?._tag === "NotFound" ? Effect.succeed([]) : Effect.fail(cause),
      ),
    ),
  };
}
