import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as HostProcess from "./HostProcess.ts";

/**
 * One comma-separated list, such as `tanstack_source,github_app_client_id=Iv23…`. A bare name
 * turns a flag on. Read once when the server starts; changing it takes a restart.
 */
const VARIABLE = "T3CODE_FEATURE_FLAGS";

const config = Config.all({
  secretProviders: Config.Boolean("secret_providers").pipe(Config.withDefault(false)),
  tanstackSource: Config.Boolean("tanstack_source").pipe(Config.withDefault(false)),
  /** The public client ID of the T3 Code for GitHub app; unset turns its sign-in off. */
  githubAppClientId: Config.option(Config.String("github_app_client_id")),
});

export type FeatureFlagValues = Config.Success<typeof config>;

export class FeatureFlags extends Context.Service<FeatureFlags, FeatureFlagValues>()(
  "@t3tools/shared/FeatureFlags",
) {}

/** The `name=value` pairs of a flags list, with a bare name read as `true`. */
function parseList(list: string | undefined): Record<string, string> {
  const record: Record<string, string> = {};
  for (const entry of (list ?? "").split(",")) {
    const separator = entry.indexOf("=");
    const name = (separator === -1 ? entry : entry.slice(0, separator)).trim();
    if (name === "") continue;
    record[name] = separator === -1 ? "true" : entry.slice(separator + 1).trim();
  }
  return record;
}

const parse = (record: Record<string, string>) => config.parse(ConfigProvider.fromUnknown(record));

export const resolve = Effect.fn("FeatureFlags.resolve")(function* (list: string | undefined) {
  return yield* parse(parseList(list)).pipe(
    Effect.catch((error) =>
      Effect.logWarning(`Ignoring invalid ${VARIABLE}; every flag is off.`, error).pipe(
        Effect.andThen(parse({})),
      ),
    ),
  );
});

export const layer = Layer.effect(
  FeatureFlags,
  Effect.flatMap(HostProcess.Environment, (env) => resolve(env[VARIABLE])),
);

export const layerTest = (values: Partial<FeatureFlagValues> = {}) =>
  Layer.effect(
    FeatureFlags,
    Effect.map(resolve(undefined), (defaults) => ({ ...defaults, ...values })),
  );
