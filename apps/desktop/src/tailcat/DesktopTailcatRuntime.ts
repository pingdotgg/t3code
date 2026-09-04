import { tailcatExecutableName, tailcatPlatformKey } from "@t3tools/tailcat/manifest";
import * as TailcatRuntime from "@t3tools/tailcat/runtime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";

/**
 * Where the desktop app looks for the Tailcat executable, in preference order:
 * the developer override, the packaged `resources/tailcat/<platform>/`
 * directory, the dev `prod-resources` staging directory, and the monorepo's
 * `native/tailcat/dist` output. A `tailcat` on PATH is the last resort and is
 * still version-checked against the pinned manifest.
 */
export function desktopTailcatBundledCandidates(
  environment: DesktopEnvironment.DesktopEnvironment["Service"],
): ReadonlyArray<string> {
  const architecture = environment.processArch as NodeJS.Architecture;
  const platformKey = tailcatPlatformKey(environment.platform, architecture);
  if (platformKey === undefined) {
    return [];
  }
  const packaged = TailcatRuntime.bundledTailcatCandidates({
    platform: environment.platform,
    architecture,
    joinPath: (...segments) => environment.path.join(...segments),
    moduleDirectory: environment.resourcesPath,
    repoRootCandidates: environment.isDevelopment ? [environment.rootDir] : [],
  });
  const staged = environment.resolveResourcePathCandidates(
    environment.path.join("tailcat", platformKey, tailcatExecutableName(environment.platform)),
  );
  return Array.from(new Set([...packaged, ...staged]));
}

/** First bundled candidate that exists on disk, for the backend bootstrap. */
export const resolveDesktopTailcatBinaryPath = Effect.fn("desktop.tailcat.resolveBinaryPath")(
  function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const fileSystem = yield* FileSystem.FileSystem;
    const override = yield* TailcatRuntime.tailcatOverridePathFromEnvironment;
    if (override !== undefined) {
      return Option.some(override);
    }
    for (const candidate of desktopTailcatBundledCandidates(environment)) {
      if (yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false))) {
        return Option.some(candidate);
      }
    }
    return Option.none<string>();
  },
);

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const overridePath = yield* TailcatRuntime.tailcatOverridePathFromEnvironment;
    return TailcatRuntime.layer({
      resolution: {
        overridePath,
        bundledCandidates: desktopTailcatBundledCandidates(environment),
        allowSystem: true,
      },
    });
  }),
);
