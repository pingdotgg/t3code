import * as NodeOS from "node:os";

import type { ServerProviderSkill } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { discoverSkillsFromRoots, type SkillRoot } from "./SkillDiscovery.ts";

export const discoverAntigravitySkills = Effect.fn("discoverAntigravitySkills")(function* (
  cwd?: string,
): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const path = yield* Path.Path;
  const home = path.join(NodeOS.homedir(), ".gemini");
  const roots: ReadonlyArray<SkillRoot> = [
    { directory: path.join(home, "config", "skills"), scope: "user" },
    { directory: path.join(home, "antigravity-cli", "skills"), scope: "user" },
    ...(cwd ? [{ directory: path.join(cwd, ".agents", "skills"), scope: "project" as const }] : []),
  ];
  return yield* discoverSkillsFromRoots(roots);
});
