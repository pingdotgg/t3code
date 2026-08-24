import * as NodeOS from "node:os";

import type { ServerProviderSkill } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { discoverSkillsFromRoots, type SkillDiscoveryRoot } from "./ClaudeSkills.ts";

export const discoverCursorSkills = Effect.fn("discoverCursorSkills")(function* (
  cwd?: string,
  home = NodeOS.homedir(),
): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const path = yield* Path.Path;
  const roots: ReadonlyArray<SkillDiscoveryRoot> = [
    { directory: path.join(home, ".claude", "skills"), scope: "user" },
    { directory: path.join(home, ".codex", "skills"), scope: "user" },
    { directory: path.join(home, ".agents", "skills"), scope: "user" },
    { directory: path.join(home, ".cursor", "skills"), scope: "user" },
    ...(cwd
      ? [
          { directory: path.join(cwd, ".claude", "skills"), scope: "project" as const },
          { directory: path.join(cwd, ".codex", "skills"), scope: "project" as const },
          { directory: path.join(cwd, ".agents", "skills"), scope: "project" as const },
          { directory: path.join(cwd, ".cursor", "skills"), scope: "project" as const },
        ]
      : []),
  ];

  return yield* discoverSkillsFromRoots(roots);
});
