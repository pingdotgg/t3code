import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as TailcatRuntime from "@t3tools/tailcat/runtime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";

/**
 * Resolves the Tailcat executable for this server process. Preference order:
 * an explicit `T3CODE_TAILCAT_BINARY` override, the path the desktop app hands
 * over in its bootstrap (the binary it ships), the copy bundled next to the CLI
 * bundle (`dist/tailcat/<platform>/`), the monorepo's fetched runtime, and
 * finally a `tailcat` already on PATH.
 */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    const platform = yield* HostProcessPlatform;
    const architecture = yield* HostProcessArchitecture;
    const overridePath = yield* TailcatRuntime.tailcatOverridePathFromEnvironment;
    const moduleDirectory = import.meta.dirname;
    const bundledCandidates = [
      ...(config.tailcatBinaryPath === undefined ? [] : [config.tailcatBinaryPath]),
      ...TailcatRuntime.bundledTailcatCandidates({
        platform,
        architecture,
        joinPath: path.join,
        moduleDirectory,
        repoRootCandidates: [
          path.resolve(moduleDirectory, "../../../.."),
          path.resolve(moduleDirectory, "../../.."),
        ],
      }),
    ];
    return TailcatRuntime.layer({
      resolution: {
        overridePath,
        bundledCandidates,
        allowSystem: true,
      },
    });
  }),
);
