import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { discoverCursorSkills } from "./CursorSkills.ts";

const writeSkill = Effect.fn(function* (
  skillsDir: string,
  directoryName: string,
  description: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const skillDir = path.join(skillsDir, directoryName);
  yield* fs.makeDirectory(skillDir, { recursive: true });
  yield* fs.writeFileString(
    path.join(skillDir, "SKILL.md"),
    ["---", `name: ${directoryName}`, `description: ${description}`, "---"].join("\n"),
  );
});

it.layer(NodeServices.layer)("discoverCursorSkills", (it) => {
  it.effect("discovers Cursor's global skill roots with native precedence", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cursor-home-" });

      yield* writeSkill(path.join(home, ".agents", "skills"), "review", "User review.");
      yield* writeSkill(path.join(home, ".cursor", "skills"), "deploy", "User deploy.");
      yield* writeSkill(path.join(home, ".cursor", "skills"), "review", "Cursor review.");

      const skills = yield* discoverCursorSkills(home);

      assert.deepEqual(skills, [
        {
          name: "deploy",
          path: path.join(home, ".cursor", "skills", "deploy", "SKILL.md"),
          enabled: true,
          scope: "user",
          description: "User deploy.",
        },
        {
          name: "review",
          path: path.join(home, ".cursor", "skills", "review", "SKILL.md"),
          enabled: true,
          scope: "user",
          description: "Cursor review.",
        },
      ]);
    }),
  );
});
