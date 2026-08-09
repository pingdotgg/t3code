import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { discoverGrokSkills } from "./GrokSkills.ts";

const writeSkill = Effect.fn(function* (
  skillsDir: string,
  directoryName: string,
  contents: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const skillDir = path.join(skillsDir, directoryName);
  yield* fs.makeDirectory(skillDir, { recursive: true });
  yield* fs.writeFileString(path.join(skillDir, "SKILL.md"), contents);
});

it.layer(NodeServices.layer)("discoverGrokSkills", (it) => {
  it.effect("discovers Claude-compatible and native skills at the project root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-grok-skills-" });
      const workspace = path.join(tempDir, "repo");
      yield* fs.makeDirectory(path.join(workspace, ".git"), { recursive: true });

      yield* writeSkill(
        path.join(workspace, ".claude", "skills"),
        "gray-horizon-godot-loop",
        "---\nname: gray-horizon-godot-loop\ndescription: Godot loop skill.\n---\n",
      );
      yield* writeSkill(
        path.join(workspace, ".grok", "skills"),
        "local-grok",
        "---\nname: local-grok\ndescription: Grok project skill.\n---\n",
      );

      const skills = yield* discoverGrokSkills(workspace);
      assert.ok(skills.some((skill) => skill.name === "gray-horizon-godot-loop"));
      assert.ok(skills.some((skill) => skill.name === "local-grok"));
      assert.equal(
        skills.find((skill) => skill.name === "gray-horizon-godot-loop")?.scope,
        "project",
      );
    }),
  );

  it.effect("walks ancestors from nested cwd up to git root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-grok-skills-" });
      const workspace = path.join(tempDir, "repo");
      const nested = path.join(workspace, "packages", "app");
      yield* fs.makeDirectory(path.join(workspace, ".git"), { recursive: true });
      yield* fs.makeDirectory(nested, { recursive: true });

      yield* writeSkill(
        path.join(workspace, ".claude", "skills"),
        "root-skill",
        "---\nname: root-skill\ndescription: From git root.\n---\n",
      );

      const skills = yield* discoverGrokSkills(nested);
      assert.ok(skills.some((skill) => skill.name === "root-skill"));
    }),
  );

  it.effect("prefers nested cwd skill over git-root skill on name collision", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-grok-skills-" });
      const workspace = path.join(tempDir, "repo");
      const nested = path.join(workspace, "packages", "app");
      yield* fs.makeDirectory(path.join(workspace, ".git"), { recursive: true });
      yield* fs.makeDirectory(nested, { recursive: true });

      yield* writeSkill(
        path.join(workspace, ".claude", "skills"),
        "shared",
        "---\nname: shared\ndescription: From git root.\n---\n",
      );
      yield* writeSkill(
        path.join(nested, ".claude", "skills"),
        "shared",
        "---\nname: shared\ndescription: From nested cwd.\n---\n",
      );

      const skills = yield* discoverGrokSkills(nested);
      const shared = skills.find((skill) => skill.name === "shared");
      assert.equal(shared?.description, "From nested cwd.");
      assert.ok(shared?.path.includes(`${path.sep}packages${path.sep}app${path.sep}`));
    }),
  );

  it.effect("prefers native .grok over Claude compatibility at the same directory tier", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-grok-skills-" });
      const workspace = path.join(tempDir, "repo");
      yield* fs.makeDirectory(path.join(workspace, ".git"), { recursive: true });

      yield* writeSkill(
        path.join(workspace, ".claude", "skills"),
        "shared",
        "---\nname: shared\ndescription: From Claude compatibility.\n---\n",
      );
      yield* writeSkill(
        path.join(workspace, ".grok", "skills"),
        "shared",
        "---\nname: shared\ndescription: From native grok.\n---\n",
      );

      const skills = yield* discoverGrokSkills(workspace);
      assert.equal(
        skills.find((skill) => skill.name === "shared")?.description,
        "From native grok.",
      );
    }),
  );
});
