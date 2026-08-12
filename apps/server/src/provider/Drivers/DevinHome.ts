import * as NodeOS from "node:os";

import { type DevinSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { expandHomePath } from "../../pathExpansion.ts";

export const DEVIN_DEFAULT_HOME_DIR = ".devin";
export const DEVIN_USAGE_TRANSCRIPT_NAME = "t3code-usage.jsonl";

export const resolveDevinHomePath = Effect.fn("resolveDevinHomePath")(function* (
  config: Pick<DevinSettings, "homePath">,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const homePath = config.homePath.trim();
  const expanded =
    homePath.length > 0
      ? expandHomePath(homePath)
      : path.join(NodeOS.homedir(), DEVIN_DEFAULT_HOME_DIR);
  return path.resolve(expanded);
});

export const makeDevinEnvironment = Effect.fn("makeDevinEnvironment")(function* (
  config: Pick<DevinSettings, "homePath">,
  baseEnv?: NodeJS.ProcessEnv,
): Effect.fn.Return<NodeJS.ProcessEnv, never, Path.Path> {
  const resolvedBaseEnv = baseEnv ?? process.env;
  const resolvedHomePath = yield* resolveDevinHomePath(config);
  return {
    ...resolvedBaseEnv,
    DEVIN_HOME: resolvedHomePath,
  };
});

export const makeDevinContinuationGroupKey = Effect.fn("makeDevinContinuationGroupKey")(function* (
  config: Pick<DevinSettings, "homePath">,
): Effect.fn.Return<string, never, Path.Path> {
  const resolvedHomePath = yield* resolveDevinHomePath(config);
  return `devin:home:${resolvedHomePath}`;
});

export const makeDevinCapabilitiesCacheKey = Effect.fn("makeDevinCapabilitiesCacheKey")(function* (
  config: Pick<DevinSettings, "binaryPath" | "homePath">,
  cwd?: string,
): Effect.fn.Return<string, never, Path.Path> {
  const resolvedHomePath = yield* resolveDevinHomePath(config);
  return `${config.binaryPath}\0${resolvedHomePath}\0${cwd ?? ""}`;
});

export const resolveDevinUsageTranscriptPath = Effect.fn("resolveDevinUsageTranscriptPath")(
  function* (config: Pick<DevinSettings, "homePath">): Effect.fn.Return<string, never, Path.Path> {
    const path = yield* Path.Path;
    const homePath = yield* resolveDevinHomePath(config);
    return path.join(homePath, DEVIN_USAGE_TRANSCRIPT_NAME);
  },
);
