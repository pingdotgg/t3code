import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { discoverJcodeSkills } from "./JcodeSkills.ts";

const writeSkill = Effect.fn(function* (
  skillsDir: string,
  directoryName: string,
  contents: string,
  agentsYaml?: { directory: string; contents: string },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const skillDir = path.join(skillsDir, directoryName);
  yield* fs.makeDirectory(skillDir, { recursive: true });
  yield* fs.writeFileString(path.join(skillDir, "SKILL.md"), contents);
  if (agentsYaml) {
    const agentsDir = path.join(skillDir, agentsYaml.directory);
    yield* fs.makeDirectory(agentsDir, { recursive: true });
    yield* fs.writeFileString(path.join(agentsDir, "openai.yaml"), agentsYaml.contents);
  }
});

// Env knobs that would otherwise leak the host into discovery.
it.layer(NodeServices.layer)("discoverJcodeSkills", (it) => {
  it.effect("discovers user and project skills by frontmatter name", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-jcode-skills-" });
      const jcodeHome = path.join(tempDir, "jcode-home");
      const workspace = path.join(tempDir, "workspace");

      yield* writeSkill(
        path.join(jcodeHome, "skills"),
        "frontend_design",
        ["---", "name: frontend-design", "description: Design guidance.", "---", ""].join("\n"),
      );
      yield* writeSkill(
        path.join(workspace, ".jcode", "skills"),
        "deploy",
        ["---", "name: deploy", "description: Deploy the app.", "---", ""].join("\n"),
      );

      const skills = yield* discoverJcodeSkills({
        homePath: jcodeHome,
        cwd: workspace,
        compatSkillsPath: path.join(tempDir, "absent"),
      });

      assert.deepEqual(skills, [
        {
          name: "deploy",
          path: path.join(workspace, ".jcode", "skills", "deploy", "SKILL.md"),
          enabled: true,
          scope: "project",
          description: "Deploy the app.",
        },
        {
          name: "frontend-design",
          path: path.join(jcodeHome, "skills", "frontend_design", "SKILL.md"),
          enabled: true,
          scope: "user",
          description: "Design guidance.",
        },
      ]);
    }),
  );

  it.effect("disable-model-invocation marks the skill user-invocation-only", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-jcode-skills-" });
      const jcodeHome = path.join(tempDir, "jcode-home");

      yield* writeSkill(
        path.join(jcodeHome, "skills"),
        "wait-what",
        [
          "---",
          "name: wait-what",
          "description: Re-pitch that.",
          "disable-model-invocation: true",
          "---",
          "",
        ].join("\n"),
      );

      const skills = yield* discoverJcodeSkills({
        homePath: jcodeHome,
        compatSkillsPath: path.join(tempDir, "absent"),
      });

      assert.deepEqual(skills, [
        {
          name: "wait-what",
          path: path.join(jcodeHome, "skills", "wait-what", "SKILL.md"),
          enabled: true,
          scope: "user",
          description: "Re-pitch that.",
          userInvocationOnly: true,
        },
      ]);
    }),
  );

  it.effect("agents yaml supplies interface labels and hides implicit use", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-jcode-skills-" });
      const jcodeHome = path.join(tempDir, "jcode-home");

      yield* writeSkill(
        path.join(jcodeHome, "skills"),
        "wait-what",
        ["---", "name: wait-what", "description: Re-pitch that.", "---", ""].join("\n"),
        {
          directory: "agents",
          contents: [
            "interface:",
            '  display_name: "Wait What"',
            '  short_description: "Re-pitch that, simpler"',
            "policy:",
            "  allow_implicit_invocation: false",
          ].join("\n"),
        },
      );

      const skills = yield* discoverJcodeSkills({
        homePath: jcodeHome,
        compatSkillsPath: path.join(tempDir, "absent"),
      });

      assert.deepEqual(skills, [
        {
          name: "wait-what",
          path: path.join(jcodeHome, "skills", "wait-what", "SKILL.md"),
          enabled: true,
          scope: "user",
          description: "Re-pitch that.",
          userInvocationOnly: true,
          displayName: "Wait What",
          shortDescription: "Re-pitch that, simpler",
        },
      ]);
    }),
  );

  it.effect("user scope shadows later roots and malformed entries are skipped", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-jcode-skills-" });
      const jcodeHome = path.join(tempDir, "jcode-home");
      const workspace = path.join(tempDir, "workspace");

      yield* writeSkill(
        path.join(jcodeHome, "skills"),
        "deploy",
        ["---", "name: deploy", "description: User wins.", "---", ""].join("\n"),
      );
      yield* writeSkill(
        path.join(workspace, ".jcode", "skills"),
        "deploy",
        ["---", "name: deploy", "description: Project copy.", "---", ""].join("\n"),
      );
      // No frontmatter at all: jcode rejects it too.
      yield* writeSkill(path.join(jcodeHome, "skills"), "broken", "# no frontmatter");

      const skills = yield* discoverJcodeSkills({
        homePath: jcodeHome,
        cwd: workspace,
        compatSkillsPath: path.join(tempDir, "absent"),
      });

      assert.lengthOf(skills, 1);
      assert.equal(skills[0]?.name, "deploy");
      assert.equal(skills[0]?.description, "User wins.");
      assert.equal(skills[0]?.scope, "user");
    }),
  );

  it.effect("a missing home yields no skills instead of failing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-jcode-skills-" });

      const skills = yield* discoverJcodeSkills({
        homePath: path.join(tempDir, "absent-home"),
        compatSkillsPath: path.join(tempDir, "absent"),
      });

      assert.deepEqual(skills, []);
    }),
  );
});
