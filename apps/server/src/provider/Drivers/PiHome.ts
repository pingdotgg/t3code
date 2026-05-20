import * as NodeOS from "node:os";

import type { PiSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { expandHomePath } from "../../pathExpansion.ts";

export const resolvePiHomePath = Effect.fn("resolvePiHomePath")(function* (
  config: Pick<PiSettings, "homePath">,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const homePath = config.homePath.trim();
  return path.resolve(homePath.length > 0 ? expandHomePath(homePath) : NodeOS.homedir());
});

export const makePiEnvironment = Effect.fn("makePiEnvironment")(function* (
  config: Pick<PiSettings, "homePath">,
  baseEnv: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<NodeJS.ProcessEnv, never, Path.Path> {
  const homePath = config.homePath.trim();
  if (homePath.length === 0) return baseEnv;
  const resolvedHomePath = yield* resolvePiHomePath(config);
  return {
    ...baseEnv,
    HOME: resolvedHomePath,
  };
});

export const makePiContinuationGroupKey = Effect.fn("makePiContinuationGroupKey")(function* (
  config: Pick<PiSettings, "homePath">,
): Effect.fn.Return<string, never, Path.Path> {
  const resolvedHomePath = yield* resolvePiHomePath(config);
  return `pi:home:${resolvedHomePath}`;
});

export const makePiCapabilitiesCacheKey = Effect.fn("makePiCapabilitiesCacheKey")(function* (
  config: Pick<PiSettings, "binaryPath" | "homePath">,
): Effect.fn.Return<string, never, Path.Path> {
  const resolvedHomePath = yield* resolvePiHomePath(config);
  return `${config.binaryPath}\0${resolvedHomePath}`;
});
