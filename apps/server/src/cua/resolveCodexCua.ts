import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";

import { expandHomePath } from "../pathExpansion.ts";
import type { CuaDriver } from "./CuaDriver.ts";
import { buildCuaDriverAppServerArgs, hasConfiguredCuaDriver } from "./codexCuaConfiguration.ts";

/** Only interactive sessions acquire managed Cua; existing host/project configuration wins. */
export const resolveCodexCua = Effect.fn("cua.resolveCodexCua")(function* (
  driver: CuaDriver["Service"],
  input: {
    readonly cwd: string;
    readonly homePath: string;
    readonly launchArgs: string;
    readonly environment?: NodeJS.ProcessEnv;
  },
) {
  if (!(yield* driver.enabled)) return [];
  const argv = tokenizeCliArgs(input.launchArgs);
  if (hasConfiguredCuaDriver(argv, undefined)) return [];

  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const home = expandHomePath(
    input.homePath || (input.environment ?? process.env).CODEX_HOME?.trim() || "~/.codex",
  );
  const paths = new Set([pathService.join(home, "config.toml")]);
  // Codex can inherit project configuration from ancestors of the session cwd.
  for (
    let directory = pathService.resolve(input.cwd);
    ;
    directory = pathService.dirname(directory)
  ) {
    paths.add(pathService.join(directory, ".codex", "config.toml"));
    if (directory === pathService.dirname(directory)) break;
  }
  for (const path of paths) {
    const config = yield* fs.readFileString(path).pipe(Effect.result);
    if (Result.isFailure(config)) {
      if (config.failure.reason._tag === "NotFound") continue;
      yield* Effect.logWarning("Could not read Codex configuration; withholding managed Cua.", {
        cause: config.failure,
      });
      return [];
    }
    if (hasConfiguredCuaDriver([], config.success)) return [];
  }
  const descriptor = yield* driver.acquire;
  return Option.isSome(descriptor) ? buildCuaDriverAppServerArgs(descriptor.value) : [];
});
