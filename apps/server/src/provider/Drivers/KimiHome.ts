import * as NodeOS from "node:os";

import type { KimiSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

function environmentHome(environment: NodeJS.ProcessEnv | undefined): string {
  return environment?.HOME?.trim() || environment?.USERPROFILE?.trim() || NodeOS.homedir();
}

function expandAgainstHome(path: Path.Path, value: string, home: string): string {
  if (value === "~") return home;
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(home, value.slice(2));
  }
  return value;
}

export const resolveKimiHomePath = Effect.fn("resolveKimiHomePath")(function* (
  config: Pick<KimiSettings, "homePath">,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const home = environmentHome(environment);
  const configuredHome = config.homePath.trim();
  const inheritedHome = environment?.KIMI_CODE_HOME?.trim() ?? "";
  const homePath = configuredHome || inheritedHome;
  return homePath
    ? path.resolve(expandAgainstHome(path, homePath, home))
    : path.resolve(home, ".kimi-code");
});

export const makeKimiEnvironment = Effect.fn("makeKimiEnvironment")(function* (
  config: Pick<KimiSettings, "homePath">,
  baseEnv?: NodeJS.ProcessEnv,
): Effect.fn.Return<NodeJS.ProcessEnv, never, Path.Path> {
  const environment = baseEnv ?? process.env;
  if (config.homePath.trim().length === 0) {
    return environment;
  }
  return {
    ...environment,
    KIMI_CODE_HOME: yield* resolveKimiHomePath(config, environment),
  };
});

export const makeKimiContinuationGroupKey = Effect.fn("makeKimiContinuationGroupKey")(function* (
  config: Pick<KimiSettings, "homePath">,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<string, never, Path.Path> {
  return `kimi:home:${yield* resolveKimiHomePath(config, environment)}`;
});
