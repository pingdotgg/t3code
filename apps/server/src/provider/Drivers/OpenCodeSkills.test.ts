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
        HOME: path.join(tempDir, "empty-home"),
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
    "preserves global and default user skills when OPENCODE_CONFIG_DIR is set with proper override precedence",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-skills-" });
        const homeDir = path.join(tempDir, "home");
        const xdgDir = path.join(tempDir, "xdg");
        const customConfigDir = path.join(tempDir, "custom-config");
        const workspace = path.join(tempDir, "workspace");

        // Global .claude skill
        yield* writeSkill(
          path.join(homeDir, ".claude", "skills"),
          "claude-skill",
          ["---", "name: claude-skill", "---"].join("\n"),
        );

        // Global .agents skill
        yield* writeSkill(
          path.join(homeDir, ".agents", "skills"),
          "agents-skill",
          ["---", "name: agents-skill", "---"].join("\n"),
        );

        // Default XDG config dir skill
        yield* writeSkill(
          path.join(xdgDir, "opencode", "skills"),
          "default-xdg-skill",
          ["---", "name: default-xdg-skill", "---"].join("\n"),
        );

        // ~/.opencode skill
        yield* writeSkill(
          path.join(homeDir, ".opencode", "skills"),
          "home-opencode-skill",
          ["---", "name: home-opencode-skill", "---"].join("\n"),
        );

        // Custom config dir skill (standalone + override)
        yield* writeSkill(
          path.join(customConfigDir, "skills"),
          "custom-skill",
          ["---", "name: custom-skill", "---"].join("\n"),
        );
        yield* writeSkill(
          path.join(homeDir, ".claude", "skills"),
          "override-target",
          ["---", "name: override-target", "description: Default claude version.", "---"].join(
            "\n",
          ),
        );
        yield* writeSkill(
          path.join(customConfigDir, "skills"),
          "override-target",
          ["---", "name: override-target", "description: Custom config version.", "---"].join("\n"),
        );

        const skills = yield* discoverOpenCodeSkills(workspace, {
          HOME: homeDir,
          XDG_CONFIG_HOME: xdgDir,
          OPENCODE_CONFIG_DIR: customConfigDir,
        });

        assert.deepEqual(
          skills.map((skill) => ({
            name: skill.name,
            description: skill.description,
            scope: skill.scope,
          })),
          [
            { name: "agents-skill", description: undefined, scope: "user" },
            { name: "claude-skill", description: undefined, scope: "user" },
            { name: "custom-skill", description: undefined, scope: "user" },
            { name: "default-xdg-skill", description: undefined, scope: "user" },
            { name: "home-opencode-skill", description: undefined, scope: "user" },
            {
              name: "override-target",
              description: "Custom config version.",
              scope: "user",
            },
          ],
        );
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
          HOME: path.join(tempDir, "empty-home"),
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
        HOME: path.join(tempDir, "empty-home"),
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
        HOME: path.join(tempDir, "empty-home"),
        OPENCODE_CONFIG_DIR: "relative-config",
      });

      assert.deepEqual(
        skills.map((skill) => skill.name),
        ["relative-skill"],
      );
      assert.equal(skills[0]?.scope, "user");
    }),
  );

  it.effect("scans home directory from HOME and USERPROFILE environment variables", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-skills-" });
      const customHome = path.join(tempDir, "custom-home");

      yield* writeSkill(
        path.join(customHome, ".opencode", "skills"),
        "home-skill",
        ["---", "name: home-skill", "---"].join("\n"),
      );

      const skills = yield* discoverOpenCodeSkills(undefined, {
        HOME: customHome,
        XDG_CONFIG_HOME: path.join(tempDir, "empty-xdg"),
      });

      assert.deepEqual(
        skills.map((skill) => skill.name),
        ["home-skill"],
      );
      assert.equal(skills[0]?.scope, "user");
    }),
  );

  it.effect(
    "discovers project skills from git ancestor directories and overrides appropriately",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-skills-" });
        const repoRoot = path.join(tempDir, "repo");
        const nestedWorkspace = path.join(repoRoot, "packages", "app");

        // Mark repoRoot with .git
        yield* fs.makeDirectory(path.join(repoRoot, ".git"), { recursive: true });
        yield* fs.makeDirectory(nestedWorkspace, { recursive: true });

        // Root skill
        yield* writeSkill(
          path.join(repoRoot, ".opencode", "skills"),
          "root-skill",
          ["---", "name: root-skill", "description: Root skill.", "---"].join("\n"),
        );

        // Overridden skill in ancestor vs child
        yield* writeSkill(
          path.join(repoRoot, ".claude", "skills"),
          "shared-skill",
          ["---", "name: shared-skill", "description: Root shared.", "---"].join("\n"),
        );
        yield* writeSkill(
          path.join(nestedWorkspace, ".opencode", "skills"),
          "shared-skill",
          ["---", "name: shared-skill", "description: Child shared.", "---"].join("\n"),
        );

        const skills = yield* discoverOpenCodeSkills(nestedWorkspace, {
          HOME: path.join(tempDir, "empty-home"),
          OPENCODE_CONFIG_DIR: path.join(tempDir, "empty-home"),
        });

        assert.deepEqual(
          skills.map((skill) => ({
            name: skill.name,
            description: skill.description,
            scope: skill.scope,
          })),
          [
            { name: "root-skill", description: "Root skill.", scope: "project" },
            { name: "shared-skill", description: "Child shared.", scope: "project" },
          ],
        );
      }),
  );

  it.effect("discovers user skills from global .claude and .agents directories", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-skills-" });
      const customHome = path.join(tempDir, "custom-home");

      yield* writeSkill(
        path.join(customHome, ".claude", "skills"),
        "global-claude-skill",
        ["---", "name: global-claude-skill", "---"].join("\n"),
      );
      yield* writeSkill(
        path.join(customHome, ".agents", "skills"),
        "global-agents-skill",
        ["---", "name: global-agents-skill", "---"].join("\n"),
      );

      const skills = yield* discoverOpenCodeSkills(undefined, {
        HOME: customHome,
        XDG_CONFIG_HOME: path.join(tempDir, "empty-xdg"),
      });

      assert.deepEqual(
        skills.map((skill) => skill.name),
        ["global-agents-skill", "global-claude-skill"],
      );
      assert.equal(skills[0]?.scope, "user");
      assert.equal(skills[1]?.scope, "user");
    }),
  );

  it.effect("does not scan parent directories for non-git workspaces", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-skills-" });
      const parentDir = path.join(tempDir, "non-git-parent");
      const childDir = path.join(parentDir, "nested-workspace");

      yield* fs.makeDirectory(childDir, { recursive: true });

      // Parent directory has a skill, but NO .git exists anywhere in the tree
      yield* writeSkill(
        path.join(parentDir, ".opencode", "skills"),
        "parent-skill",
        ["---", "name: parent-skill", "---"].join("\n"),
      );
      yield* writeSkill(
        path.join(childDir, ".opencode", "skills"),
        "child-skill",
        ["---", "name: child-skill", "---"].join("\n"),
      );

      const skills = yield* discoverOpenCodeSkills(childDir, {
        HOME: path.join(tempDir, "empty-home"),
        OPENCODE_CONFIG_DIR: path.join(tempDir, "empty-config"),
      });

      assert.deepEqual(
        skills.map((skill) => skill.name),
        ["child-skill"],
      );
    }),
  );

  it.effect("returns an empty list when no skill roots exist", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-skills-" });

      const skills = yield* discoverOpenCodeSkills(path.join(tempDir, "missing-workspace"), {
        HOME: path.join(tempDir, "missing-home"),
        OPENCODE_CONFIG_DIR: path.join(tempDir, "missing-home"),
      });

      assert.deepEqual(skills, []);
    }),
  );

  it.effect("OPENCODE_DISABLE_EXTERNAL_SKILLS skips every disk-scanned root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-skills-" });
      const homeDir = path.join(tempDir, "home");
      const workspace = path.join(tempDir, "workspace");
      yield* fs.makeDirectory(workspace, { recursive: true });

      yield* writeSkill(
        path.join(homeDir, ".opencode", "skills"),
        "user-skill",
        ["---", "name: user-skill", "---"].join("\n"),
      );
      yield* writeSkill(
        path.join(workspace, ".opencode", "skills"),
        "project-skill",
        ["---", "name: project-skill", "---"].join("\n"),
      );

      const skills = yield* discoverOpenCodeSkills(workspace, {
        HOME: homeDir,
        OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
      });

      assert.deepEqual(skills, []);
    }),
  );

  it.effect(
    "OPENCODE_DISABLE_CLAUDE_CODE_SKILLS skips .claude roots but keeps .agents and .opencode",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-skills-" });
        const homeDir = path.join(tempDir, "home");
        const workspace = path.join(tempDir, "workspace");

        yield* writeSkill(
          path.join(homeDir, ".claude", "skills"),
          "user-claude-skill",
          ["---", "name: user-claude-skill", "---"].join("\n"),
        );
        yield* writeSkill(
          path.join(homeDir, ".agents", "skills"),
          "agents-skill",
          ["---", "name: agents-skill", "---"].join("\n"),
        );
        yield* writeSkill(
          path.join(workspace, ".claude", "skills"),
          "project-claude-skill",
          ["---", "name: project-claude-skill", "---"].join("\n"),
        );
        yield* writeSkill(
          path.join(workspace, ".opencode", "skills"),
          "project-opencode-skill",
          ["---", "name: project-opencode-skill", "---"].join("\n"),
        );

        const skills = yield* discoverOpenCodeSkills(workspace, {
          HOME: homeDir,
          OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
        });

        assert.deepEqual(
          skills.map((skill) => skill.name),
          ["agents-skill", "project-opencode-skill"],
        );
      }),
  );

  it.effect("OPENCODE_DISABLE_CLAUDE_CODE also skips .claude skill roots", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-skills-" });
      const homeDir = path.join(tempDir, "home");

      yield* writeSkill(
        path.join(homeDir, ".claude", "skills"),
        "claude-skill",
        ["---", "name: claude-skill", "---"].join("\n"),
      );
      yield* writeSkill(
        path.join(homeDir, ".agents", "skills"),
        "agents-skill",
        ["---", "name: agents-skill", "---"].join("\n"),
      );

      const skills = yield* discoverOpenCodeSkills(undefined, {
        HOME: homeDir,
        OPENCODE_DISABLE_CLAUDE_CODE: "true",
      });

      assert.deepEqual(
        skills.map((skill) => skill.name),
        ["agents-skill"],
      );
    }),
  );

  it.effect("disable flags set to 0 or false keep discovery enabled", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-skills-" });
      const homeDir = path.join(tempDir, "home");

      yield* writeSkill(
        path.join(homeDir, ".claude", "skills"),
        "claude-skill",
        ["---", "name: claude-skill", "---"].join("\n"),
      );

      for (const value of ["0", "false", ""]) {
        const skills = yield* discoverOpenCodeSkills(undefined, {
          HOME: homeDir,
          OPENCODE_DISABLE_EXTERNAL_SKILLS: value,
          OPENCODE_DISABLE_CLAUDE_CODE: value,
          OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: value,
        });
        assert.deepEqual(
          skills.map((skill) => skill.name),
          ["claude-skill"],
        );
      }
    }),
  );
});
