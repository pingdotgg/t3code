import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as HostProcess from "./HostProcess.ts";

/**
 * One comma-separated list, such as `tanstack_source,github_app_client_id=Iv23…`. A bare name
 * turns a flag on. Read once when the server starts; changing it takes a restart.
 */
const VARIABLE = "T3CODE_FEATURE_FLAGS";

const NAMES = {
  secretProviders: "secret_providers",
  tanstackSource: "tanstack_source",
  /** The public client ID of the T3 Code for GitHub app; unset turns its sign-in off. */
  githubAppClientId: "github_app_client_id",
} as const;

const config = Config.all({
  secretProviders: Config.Boolean(NAMES.secretProviders).pipe(Config.withDefault(false)),
  tanstackSource: Config.Boolean(NAMES.tanstackSource).pipe(Config.withDefault(false)),
  githubAppClientId: Config.option(Config.String(NAMES.githubAppClientId)),
});

export type FeatureFlagValues = Config.Success<typeof config>;

export const DEFAULTS: FeatureFlagValues = {
  secretProviders: false,
  tanstackSource: false,
  githubAppClientId: Option.none(),
};

export class FeatureFlags extends Context.Service<FeatureFlags, FeatureFlagValues>()(
  "@t3tools/shared/FeatureFlags",
) {}

const KNOWN_NAMES: ReadonlySet<string> = new Set(Object.values(NAMES));

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

export const resolve = Effect.fn("FeatureFlags.resolve")(function* (list: string | undefined) {
  const record = parseList(list);
  const unknown = Object.keys(record).filter((name) => !KNOWN_NAMES.has(name));
  if (unknown.length > 0) {
    yield* Effect.logWarning(`Ignoring unknown ${VARIABLE}: ${unknown.join(", ")}`);
  }
  return yield* config
    .parse(ConfigProvider.fromUnknown(record))
    .pipe(
      Effect.catch((error) =>
        Effect.logWarning(`Ignoring invalid ${VARIABLE}; every flag is off.`, error).pipe(
          Effect.as(DEFAULTS),
        ),
      ),
    );
});

export const layer = Layer.effect(
  FeatureFlags,
  Effect.gen(function* () {
    return yield* resolve((yield* HostProcess.Environment)[VARIABLE]);
  }),
);

export const layerTest = (values: Partial<FeatureFlagValues> = {}) =>
  Layer.succeed(FeatureFlags, { ...DEFAULTS, ...values });
