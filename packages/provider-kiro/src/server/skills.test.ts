import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { discoverKiroSkills } from "./skills.ts";

describe("discoverKiroSkills", () => {
  it.effect("discovers project and user skills with project precedence", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-kiro-skills-home-" });
      const cwd = path.join(home, "projects", "demo");
      const writeSkill = (directory: string, name: string, description: string) =>
        fileSystem
          .makeDirectory(path.join(directory, name), { recursive: true })
          .pipe(
            Effect.andThen(() =>
              fileSystem.writeFileString(
                path.join(directory, name, "SKILL.md"),
                `---\nname: ${name}\ndescription: ${description}\n---\n`,
              ),
            ),
          );

      yield* writeSkill(path.join(home, ".kiro", "skills"), "shared", "User copy");
      yield* writeSkill(path.join(home, ".kiro", "skills"), "global", "Global skill");
      yield* writeSkill(path.join(cwd, ".kiro", "skills"), "shared", "Project copy");
      yield* fileSystem.writeFileString(
        path.join(cwd, ".kiro", "skills", "shared", "SKILL.md"),
        [
          "---",
          "name: shared # project override",
          "description: >-",
          "  Project copy",
          "---",
          "",
        ].join("\n"),
      );
      yield* writeSkill(path.join(cwd, ".agents", "skills"), "agent-only", "Agent skill");
      yield* writeSkill(
        path.join(home, "projects", ".kiro", "skills"),
        "parent-only",
        "Parent skill",
      );

      expect(yield* discoverKiroSkills({ cwd, home })).toEqual([
        {
          name: "shared",
          description: "Project copy",
          path: path.join(cwd, ".kiro", "skills", "shared", "SKILL.md"),
          scope: "project",
          enabled: true,
        },
        {
          name: "global",
          description: "Global skill",
          path: path.join(home, ".kiro", "skills", "global", "SKILL.md"),
          scope: "user",
          enabled: true,
        },
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
