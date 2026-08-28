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

const isolatedEnv = (home: string, grokHome: string): NodeJS.ProcessEnv => ({
  HOME: home,
  GROK_HOME: grokHome,
});

it.layer(NodeServices.layer)("discoverGrokSkills", (it) => {
  it.effect("discovers bundled, user agents, user grok, and project skills", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-grok-skills-" });
      const userHome = path.join(tempDir, "user-home");
      const grokHome = path.join(userHome, ".grok");
      const workspace = path.join(tempDir, "workspace");

      yield* writeSkill(
        path.join(grokHome, "bundled", "skills"),
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
        path.join(userHome, ".agents", "skills"),
        "unslop",
        ["---", "name: unslop", "description: Cut AI tells.", "---", "", "# Unslop"].join("\n"),
      );
      yield* writeSkill(
        path.join(grokHome, "skills"),
        "file-pr",
        ["---", "name: file-pr", "description: Open a PR.", "---", "", "# PR"].join("\n"),
      );
      yield* writeSkill(
        path.join(workspace, ".grok", "skills"),
        "deploy",
        ["---", "name: deploy", "description: Deploy the app.", "---", "", "# Deploy"].join("\n"),
      );

      const skills = yield* discoverGrokSkills(workspace, isolatedEnv(userHome, grokHome));

      assert.deepEqual(skills, [
        {
          name: "create-skill",
          path: path.join(grokHome, "bundled", "skills", "create-skill", "SKILL.md"),
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
          name: "file-pr",
          path: path.join(grokHome, "skills", "file-pr", "SKILL.md"),
          enabled: true,
          scope: "user",
          description: "Open a PR.",
        },
        {
          name: "unslop",
          path: path.join(userHome, ".agents", "skills", "unslop", "SKILL.md"),
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
      const userHome = path.join(tempDir, "user-home");
      const grokHome = path.join(userHome, ".grok");
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

      const skills = yield* discoverGrokSkills(workspace, isolatedEnv(userHome, grokHome));

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

  it.effect("deduplicates matching skill names across roots, preferring later roots", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-grok-skills-" });
      const userHome = path.join(tempDir, "user-home");
      const grokHome = path.join(userHome, ".grok");
      const workspace = path.join(tempDir, "workspace");

      yield* writeSkill(
        path.join(grokHome, "bundled", "skills"),
        "deploy",
        ["---", "name: deploy", "description: Bundled deploy.", "---"].join("\n"),
      );
      yield* writeSkill(
        path.join(userHome, ".agents", "skills"),
        "deploy",
        ["---", "name: deploy", "description: Agents user deploy.", "---"].join("\n"),
      );
      yield* writeSkill(
        path.join(grokHome, "skills"),
        "deploy",
        ["---", "name: deploy", "description: User grok deploy.", "---"].join("\n"),
      );
      yield* writeSkill(
        path.join(workspace, ".agents", "skills"),
        "deploy",
        ["---", "name: deploy", "description: Agents project deploy.", "---"].join("\n"),
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

      const skills = yield* discoverGrokSkills(workspace, isolatedEnv(userHome, grokHome));

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

  it.effect("deduplicates case-insensitively across .agents and .grok user skills", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-grok-skills-" });
      const userHome = path.join(tempDir, "user-home");
      const grokHome = path.join(userHome, ".grok");

      yield* writeSkill(
        path.join(userHome, ".agents", "skills"),
        "html-communication",
        ["---", "name: Html-Communication", "description: Agents copy.", "---"].join("\n"),
      );
      yield* writeSkill(
        path.join(grokHome, "skills"),
        "html-communication",
        ["---", "name: html-communication", "description: Grok copy.", "---"].join("\n"),
      );

      const skills = yield* discoverGrokSkills(undefined, isolatedEnv(userHome, grokHome));

      assert.deepEqual(skills, [
        {
          name: "html-communication",
          path: path.join(grokHome, "skills", "html-communication", "SKILL.md"),
          enabled: true,
          scope: "user",
          description: "Grok copy.",
        },
      ]);
    }),
  );

  it.effect("skips malformed frontmatter and non-skill entries", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-grok-skills-" });
      const userHome = path.join(tempDir, "user-home");
      const grokHome = path.join(userHome, ".grok");
      const skillsDir = path.join(grokHome, "skills");

      yield* writeSkill(skillsDir, "no-frontmatter", "# Just a heading\n");
      yield* writeSkill(skillsDir, "broken-yaml", "---\nname: [unclosed\n---\n");
      yield* writeSkill(
        skillsDir,
        "good",
        ["---", "name: good", "description: Works.", "---"].join("\n"),
      );
      yield* fs.makeDirectory(skillsDir, { recursive: true });
      yield* fs.writeFileString(path.join(skillsDir, "README.md"), "not a skill");

      const skills = yield* discoverGrokSkills(undefined, isolatedEnv(userHome, grokHome));

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
      const userHome = path.join(tempDir, "user-home");
      const grokHome = path.join(userHome, ".grok");
      const agentsHome = path.join(userHome, ".agents", "skills");
      const skillsDir = path.join(grokHome, "skills");

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

      const skills = yield* discoverGrokSkills(undefined, isolatedEnv(userHome, grokHome));

      // Same name in ~/.agents and ~/.grok (symlink) collapses to one row.
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
