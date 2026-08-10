import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { discoverGrokSkills } from "./GrokSkills.ts";

const writeSkill = Effect.fn("writeGrokSkill")(function* (
  root: string,
  directoryName: string,
  description: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const skillDirectory = path.join(root, directoryName);
  yield* fs.makeDirectory(skillDirectory, { recursive: true });
  yield* fs.writeFileString(
    path.join(skillDirectory, "SKILL.md"),
    ["---", `name: ${directoryName}`, `description: ${description}`, "---"].join("\n"),
  );
});

it.layer(NodeServices.layer)("discoverGrokSkills", (it) => {
  it.effect("scans Grok user and project roots in override order", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-grok-skills-" });
      const homeDirectory = path.join(tempDir, "home");
      const cwd = path.join(tempDir, "workspace");
      const roots = [
        path.join(homeDirectory, ".agents", "skills"),
        path.join(homeDirectory, ".grok", "skills"),
        path.join(cwd, ".agents", "skills"),
        path.join(cwd, ".grok", "skills"),
      ];

      yield* Effect.forEach(roots, (root, index) => writeSkill(root, "shared", `root-${index}`), {
        discard: true,
      });
      yield* writeSkill(roots[0]!, "agents-user", "From user agents.");
      yield* writeSkill(roots[1]!, "grok-user", "From user Grok.");
      yield* writeSkill(roots[2]!, "agents-project", "From project agents.");
      yield* writeSkill(roots[3]!, "grok-project", "From project Grok.");

      const skills = yield* discoverGrokSkills(cwd, {}, homeDirectory);

      assert.deepEqual(
        skills.map(({ name, scope, description }) => ({ name, scope, description })),
        [
          { name: "agents-project", scope: "project", description: "From project agents." },
          { name: "agents-user", scope: "user", description: "From user agents." },
          { name: "grok-project", scope: "project", description: "From project Grok." },
          { name: "grok-user", scope: "user", description: "From user Grok." },
          { name: "shared", scope: "project", description: "root-3" },
        ],
      );
      assert.equal(
        skills.find((skill) => skill.name === "shared")?.path,
        path.join(roots[3]!, "shared", "SKILL.md"),
      );
    }),
  );
});
