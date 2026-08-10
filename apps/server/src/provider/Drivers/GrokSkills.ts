import * as NodeOS from "node:os";

import type { ServerProviderSkill } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { discoverSkillsFromRoots } from "./ProviderSkills.ts";

export const discoverGrokSkills = Effect.fn("discoverGrokSkills")(function* (
  cwd?: string,
  homeDirectory = NodeOS.homedir(),
): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const path = yield* Path.Path;

  return yield* discoverSkillsFromRoots([
    { directory: path.join(homeDirectory, ".agents", "skills"), scope: "user" },
    { directory: path.join(homeDirectory, ".grok", "skills"), scope: "user" },
    ...(cwd
      ? [
          { directory: path.join(cwd, ".agents", "skills"), scope: "project" },
          { directory: path.join(cwd, ".grok", "skills"), scope: "project" },
        ]
      : []),
  ]);
});
