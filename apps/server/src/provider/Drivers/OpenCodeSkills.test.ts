import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { discoverOpenCodeSkills } from "./OpenCodeSkills.ts";

const writeSkill = Effect.fn(function* (skillDir: string, contents: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(skillDir, { recursive: true });
  yield* fs.writeFileString(path.join(skillDir, "SKILL.md"), contents);
});

const frontmatter = (name: string, description: string) =>
  ["---", `name: ${name}`, `description: ${description}`, "---", "", "# Body"].join("\n");

it.layer(NodeServices.layer)("discoverOpenCodeSkills", (it) => {
  it.effect("discovers user and project skills with frontmatter metadata", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-skills-" });
      const configDir = path.join(tempDir, "opencode-config");
      const workspace = path.join(tempDir, "workspace");

      yield* writeSkill(
        path.join(configDir, "skills", "planner"),
        frontmatter("planner", "Plan the work."),
      );
      yield* writeSkill(
        path.join(workspace, ".opencode", "skills", "deploy"),
        frontmatter("deploy", "Deploy the app."),
      );

      const skills = yield* discoverOpenCodeSkills(workspace, {
        OPENCODE_CONFIG_DIR: configDir,
      });

      assert.deepStrictEqual(
        skills.map((skill) => ({ name: skill.name, scope: skill.scope })),
        [
          { name: "deploy", scope: "project" },
          { name: "planner", scope: "user" },
        ],
      );
      assert.strictEqual(skills[1]?.description, "Plan the work.");
      assert.strictEqual(skills[1]?.path, path.join(configDir, "skills", "planner", "SKILL.md"));
      assert.strictEqual(skills[1]?.enabled, true);
    }),
  );

  it.effect("accepts the singular skill directory and nested skills", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-skills-" });
      const configDir = path.join(tempDir, "opencode-config");

      yield* writeSkill(
        path.join(configDir, "skill", "singular"),
        frontmatter("singular", "Singular directory."),
      );
      yield* writeSkill(
        path.join(configDir, "skills", "group", "nested"),
        frontmatter("nested", "Nested one level deeper."),
      );

      const skills = yield* discoverOpenCodeSkills(undefined, {
        OPENCODE_CONFIG_DIR: configDir,
      });

      assert.deepStrictEqual(
        skills.map((skill) => skill.name),
        ["nested", "singular"],
      );
    }),
  );

  it.effect("lets a project skill win a name collision", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-skills-" });
      const configDir = path.join(tempDir, "opencode-config");
      const workspace = path.join(tempDir, "workspace");

      yield* writeSkill(path.join(configDir, "skills", "review"), frontmatter("review", "User."));
      yield* writeSkill(
        path.join(workspace, ".opencode", "skills", "review"),
        frontmatter("review", "Project."),
      );

      const skills = yield* discoverOpenCodeSkills(workspace, {
        OPENCODE_CONFIG_DIR: configDir,
      });

      assert.strictEqual(skills.length, 1);
      assert.strictEqual(skills[0]?.scope, "project");
      assert.strictEqual(skills[0]?.description, "Project.");
    }),
  );

  it.effect("skips entries without parseable frontmatter and missing roots", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-skills-" });
      const configDir = path.join(tempDir, "opencode-config");

      yield* writeSkill(path.join(configDir, "skills", "no-frontmatter"), "# Just a heading");
      yield* writeSkill(
        path.join(configDir, "skills", "malformed"),
        ["---", "name: [unclosed", "---", "", "# Body"].join("\n"),
      );
      yield* writeSkill(path.join(configDir, "skills", "unnamed"), ["---", "---", ""].join("\n"));
      yield* writeSkill(path.join(configDir, "skills", "good"), frontmatter("good", "Loads."));

      const skills = yield* discoverOpenCodeSkills(path.join(tempDir, "does-not-exist"), {
        OPENCODE_CONFIG_DIR: configDir,
      });

      assert.deepStrictEqual(
        skills.map((skill) => skill.name),
        ["good"],
      );
    }),
  );
});
