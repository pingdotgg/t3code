import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { isCommandAvailable } from "@t3tools/shared/shell";

const DEFAULT_DEVIN_BINARIES = ["devin", "devin-desktop"] as const;

export const resolveEffectiveDevinBinary = Effect.fn("resolveEffectiveDevinBinary")(function* (
  binaryPath: string | null | undefined,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<string, never, FileSystem.FileSystem | Path.Path> {
  const configured = (binaryPath ?? "").trim() || "devin";

  const env = environment ?? process.env;

  if (!DEFAULT_DEVIN_BINARIES.includes(configured as (typeof DEFAULT_DEVIN_BINARIES)[number])) {
    return configured;
  }

  if (yield* isCommandAvailable(configured, { env })) {
    return configured;
  }

  for (const candidate of DEFAULT_DEVIN_BINARIES) {
    if (candidate === configured) continue;
    if (yield* isCommandAvailable(candidate, { env })) {
      return candidate;
    }
  }

  return configured;
});
