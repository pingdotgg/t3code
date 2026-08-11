import * as NodeOS from "node:os";

import type { ServerProviderSkill } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { discoverSkillsFromRoots } from "./ProviderSkills.ts";

export const discoverGrokSkills = Effect.fn("discoverGrokSkills")(function* (
  cwd?: string,
  environment: NodeJS.ProcessEnv = process.env,
  fallbackHomeDirectory = NodeOS.homedir(),
): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const environmentHome =
    (platform === "win32" ? environment.USERPROFILE : environment.HOME)?.trim() ?? "";
  const homeDirectory =
    environmentHome.length > 0
      ? cwd
        ? path.resolve(cwd, environmentHome)
        : path.resolve(environmentHome)
      : fallbackHomeDirectory;
  const environmentGrokHome = environment.GROK_HOME?.trim() ?? "";
  const grokHome =
    environmentGrokHome.length > 0
      ? cwd
        ? path.resolve(cwd, environmentGrokHome)
        : path.resolve(environmentGrokHome)
      : path.join(homeDirectory, ".grok");

  return yield* discoverSkillsFromRoots([
    { directory: path.join(homeDirectory, ".agents", "skills"), scope: "user" },
    { directory: path.join(grokHome, "skills"), scope: "user" },
    ...(cwd
      ? [
          { directory: path.join(cwd, ".agents", "skills"), scope: "project" },
          { directory: path.join(cwd, ".grok", "skills"), scope: "project" },
        ]
      : []),
  ]);
});
