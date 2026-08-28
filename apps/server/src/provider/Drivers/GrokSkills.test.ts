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
  it.effect("discovers bundled, user, and project skills with frontmatter metadata", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-grok-skills-" });
      const home = path.join(tempDir, "grok-home");
      const workspace = path.join(tempDir, "workspace");

      yield* writeSkill(
        path.join(home, "bundled", "skills"),
        "create-skill",
        [
          "---",
          "name: create-skill",
          "description: Scaffold a new skill.",
          "---",
          "",
          "# Body",
        ].join("\n"),
      );
      yield* writeSkill(
        path.join(home, "skills"),
        "unslop",
        ["---", "name: unslop", "description: Cut AI tells.", "---", "", "# Unslop"].join("\n"),
      );
      yield* writeSkill(
        path.join(workspace, ".grok", "skills"),
        "deploy",
        ["---", "name: deploy", "description: Deploy the app.", "---", "", "# Deploy"].join("\n"),
      );

      const skills = yield* discoverGrokSkills(workspace, { GROK_HOME: home });

      assert.deepEqual(skills, [
        {
          name: "create-skill",
          path: path.join(home, "bundled", "skills", "create-skill", "SKILL.md"),
          enabled: true,
          scope: "system",
          description: "Scaffold a new skill.",
        },
        {
          name: "deploy",
          path: path.join(workspace, ".grok", "skills", "deploy", "SKILL.md"),
          enabled: true,
          scope: "project",
          description: "Deploy the app.",
        },
        {
          name: "unslop",
          path: path.join(home, "skills", "unslop", "SKILL.md"),
          enabled: true,
          scope: "user",
          description: "Cut AI tells.",
        },
      ]);
    }),
  );

  it.effect("discovers project skills from workspace .agents and .claude directories", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-grok-skills-" });
      const home = path.join(tempDir, "grok-home");
      const workspace = path.join(tempDir, "workspace");

      yield* writeSkill(
        path.join(workspace, ".agents", "skills"),
        "review",
        ["---", "name: review", "description: Review the changes.", "---"].join("\n"),
      );
      yield* writeSkill(
        path.join(workspace, ".claude", "skills"),
        "ship",
        ["---", "name: ship", "description: Ship the release.", "---"].join("\n"),
      );

      const skills = yield* discoverGrokSkills(workspace, { GROK_HOME: home });

      assert.deepEqual(skills, [
        {
          name: "review",
          path: path.join(workspace, ".agents", "skills", "review", "SKILL.md"),
          enabled: true,
          scope: "project",
          description: "Review the changes.",
        },
        {
          name: "ship",
          path: path.join(workspace, ".claude", "skills", "ship", "SKILL.md"),
          enabled: true,
          scope: "project",
          description: "Ship the release.",
        },
      ]);
    }),
  );

  it.effect("prefers workspace .grok skills on name collisions", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-grok-skills-" });
      const home = path.join(tempDir, "grok-home");
      const workspace = path.join(tempDir, "workspace");

      yield* writeSkill(
        path.join(home, "bundled", "skills"),
        "deploy",
        ["---", "name: deploy", "description: Bundled deploy.", "---"].join("\n"),
      );
      yield* writeSkill(
        path.join(home, "skills"),
        "deploy",
        ["---", "name: deploy", "description: User deploy.", "---"].join("\n"),
      );
      yield* writeSkill(
        path.join(workspace, ".agents", "skills"),
        "deploy",
        ["---", "name: deploy", "description: Agents deploy.", "---"].join("\n"),
      );
      yield* writeSkill(
        path.join(workspace, ".claude", "skills"),
        "deploy",
        ["---", "name: deploy", "description: Claude deploy.", "---"].join("\n"),
      );
      yield* writeSkill(
        path.join(workspace, ".grok", "skills"),
        "deploy",
        ["---", "name: deploy", "description: Grok deploy.", "---"].join("\n"),
      );

      const skills = yield* discoverGrokSkills(workspace, { GROK_HOME: home });

      assert.deepEqual(skills, [
        {
          name: "deploy",
          path: path.join(workspace, ".grok", "skills", "deploy", "SKILL.md"),
          enabled: true,
          scope: "project",
          description: "Grok deploy.",
        },
      ]);
    }),
  );

  it.effect("skips malformed frontmatter and non-skill entries", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-grok-skills-" });
      const home = path.join(tempDir, "grok-home");
      const skillsDir = path.join(home, "skills");

      yield* writeSkill(skillsDir, "no-frontmatter", "# Just a heading\n");
      yield* writeSkill(skillsDir, "broken-yaml", "---\nname: [unclosed\n---\n");
      yield* writeSkill(
        skillsDir,
        "good",
        ["---", "name: good", "description: Works.", "---"].join("\n"),
      );
      yield* fs.makeDirectory(skillsDir, { recursive: true });
      yield* fs.writeFileString(path.join(skillsDir, "README.md"), "not a skill");

      const skills = yield* discoverGrokSkills(undefined, { GROK_HOME: home });

      assert.deepEqual(skills, [
        {
          name: "good",
          path: path.join(skillsDir, "good", "SKILL.md"),
          enabled: true,
          scope: "user",
          description: "Works.",
        },
        {
          name: "no-frontmatter",
          path: path.join(skillsDir, "no-frontmatter", "SKILL.md"),
          enabled: true,
          scope: "user",
        },
      ]);
    }),
  );

  it.effect("follows symlinked skill directories", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-grok-skills-" });
      const home = path.join(tempDir, "grok-home");
      const agentsHome = path.join(tempDir, "agents-skills");
      const skillsDir = path.join(home, "skills");

      yield* writeSkill(
        agentsHome,
        "html-communication",
        ["---", "name: html-communication", "description: Publish an HTML report.", "---"].join(
          "\n",
        ),
      );
      yield* fs.makeDirectory(skillsDir, { recursive: true });
      yield* fs.symlink(
        path.join(agentsHome, "html-communication"),
        path.join(skillsDir, "html-communication"),
      );

      const skills = yield* discoverGrokSkills(undefined, { GROK_HOME: home });

      assert.deepEqual(skills, [
        {
          name: "html-communication",
          path: path.join(skillsDir, "html-communication", "SKILL.md"),
          enabled: true,
          scope: "user",
          description: "Publish an HTML report.",
        },
      ]);
    }),
  );
});
