import * as NodeOS from "node:os";

import type { HermesSettings } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { expandHomePath } from "../../pathExpansion.ts";

export const resolveHermesHomePath = Effect.fn("resolveHermesHomePath")(function* (
  config: Pick<HermesSettings, "homePath">,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const configured = config.homePath.trim();
  const inherited = environment.HERMES_HOME?.trim();
  const environmentHome = environment.HOME?.trim() || environment.USERPROFILE?.trim();
  const platform = yield* HostProcessPlatform;
  const platformDefault =
    platform === "win32" && environment.LOCALAPPDATA?.trim()
      ? path.join(environment.LOCALAPPDATA.trim(), "hermes")
      : path.join(environmentHome || NodeOS.homedir(), ".hermes");
  return path.resolve(expandHomePath(configured || inherited || platformDefault));
});

export const makeHermesEnvironment = Effect.fn("makeHermesEnvironment")(function* (
  config: Pick<HermesSettings, "homePath">,
  baseEnv: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<NodeJS.ProcessEnv, never, Path.Path> {
  if (!config.homePath.trim()) return baseEnv;
  return {
    ...baseEnv,
    HERMES_HOME: yield* resolveHermesHomePath(config, baseEnv),
  };
});

export const makeHermesContinuationGroupKey = Effect.fn("makeHermesContinuationGroupKey")(
  function* (
    config: Pick<HermesSettings, "homePath">,
    environment?: NodeJS.ProcessEnv,
  ): Effect.fn.Return<string, never, Path.Path> {
    return `hermes:home:${yield* resolveHermesHomePath(config, environment)}`;
  },
);
