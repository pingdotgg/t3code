import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { discoverOpenCodeSkills } from "./OpenCodeSkills.ts";

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

it.layer(NodeServices.layer)("discoverOpenCodeSkills", (it) => {
  it.effect("discovers user and project skills with frontmatter metadata", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-skills-" });
      const configDir = path.join(tempDir, "opencode-home");
      const workspace = path.join(tempDir, "workspace");

      yield* writeSkill(
        path.join(configDir, "skills"),
        "user-skill",
        ["---", "name: user-skill", "description: User level skill.", "---", "", "# Body"].join(
          "\n",
        ),
      );
      yield* writeSkill(
        path.join(workspace, ".opencode", "skills"),
        "project-skill",
        [
          "---",
          "name: project-skill",
          "description: Project level skill.",
          "---",
          "",
          "# Deploy",
        ].join("\n"),
      );

      const skills = yield* discoverOpenCodeSkills(workspace, {
        OPENCODE_CONFIG_DIR: configDir,
      });

      assert.deepEqual(skills, [
        {
          name: "project-skill",
          path: path.join(workspace, ".opencode", "skills", "project-skill", "SKILL.md"),
          enabled: true,
          scope: "project",
          description: "Project level skill.",
        },
        {
          name: "user-skill",
          path: path.join(configDir, "skills", "user-skill", "SKILL.md"),
          enabled: true,
          scope: "user",
          description: "User level skill.",
        },
      ]);
    }),
  );

  it.effect(
    "discovers project skills from .claude, .agents, and .opencode directories with proper precedence",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-skills-" });
        const configDir = path.join(tempDir, "opencode-home");
        const workspace = path.join(tempDir, "workspace");

        yield* writeSkill(
          path.join(configDir, "skills"),
          "deploy",
          ["---", "name: deploy", "description: User deploy.", "---"].join("\n"),
        );
        yield* writeSkill(
          path.join(workspace, ".claude", "skills"),
          "deploy",
          ["---", "name: deploy", "description: Claude deploy.", "---"].join("\n"),
        );
        yield* writeSkill(
          path.join(workspace, ".agents", "skills"),
          "deploy",
          ["---", "name: deploy", "description: Agents deploy.", "---"].join("\n"),
        );
        yield* writeSkill(
          path.join(workspace, ".opencode", "skills"),
          "deploy",
          ["---", "name: deploy", "description: OpenCode deploy.", "---"].join("\n"),
        );

        const skills = yield* discoverOpenCodeSkills(workspace, {
          OPENCODE_CONFIG_DIR: configDir,
        });

        assert.deepEqual(skills, [
          {
            name: "deploy",
            path: path.join(workspace, ".opencode", "skills", "deploy", "SKILL.md"),
            enabled: true,
            scope: "project",
            description: "OpenCode deploy.",
          },
        ]);
      }),
  );

  it.effect("falls back to the directory name and skips malformed frontmatter", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-skills-" });
      const configDir = path.join(tempDir, "opencode-home");
      const skillsDir = path.join(configDir, "skills");

      yield* writeSkill(skillsDir, "no-frontmatter", "# Just a heading\n");
      yield* writeSkill(skillsDir, "broken-yaml", "---\nname: [unclosed\n---\n");
      yield* fs.makeDirectory(skillsDir, { recursive: true });
      yield* fs.writeFileString(path.join(skillsDir, "README.md"), "not a skill");

      const skills = yield* discoverOpenCodeSkills(undefined, {
        OPENCODE_CONFIG_DIR: configDir,
      });

      assert.deepEqual(
        skills.map((skill) => skill.name),
        ["no-frontmatter"],
      );
      assert.equal(skills[0]?.description, undefined);
    }),
  );

  it.effect("resolves a relative OPENCODE_CONFIG_DIR against the workspace cwd", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-skills-" });
      const workspace = path.join(tempDir, "workspace");
      yield* fs.makeDirectory(workspace, { recursive: true });

      yield* writeSkill(
        path.join(workspace, "relative-config", "skills"),
        "relative-skill",
        ["---", "name: relative-skill", "---"].join("\n"),
      );

      const skills = yield* discoverOpenCodeSkills(workspace, {
        OPENCODE_CONFIG_DIR: "relative-config",
      });

      assert.deepEqual(
        skills.map((skill) => skill.name),
        ["relative-skill"],
      );
      assert.equal(skills[0]?.scope, "user");
    }),
  );

  it.effect("returns an empty list when no skill roots exist", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-skills-" });

      const skills = yield* discoverOpenCodeSkills(path.join(tempDir, "missing-workspace"), {
        OPENCODE_CONFIG_DIR: path.join(tempDir, "missing-home"),
      });

      assert.deepEqual(skills, []);
    }),
  );
});
