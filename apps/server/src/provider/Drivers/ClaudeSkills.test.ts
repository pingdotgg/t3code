import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { discoverClaudeSkills } from "./ClaudeSkills.ts";

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

it.layer(NodeServices.layer)("discoverClaudeSkills", (it) => {
  it.effect("discovers user and project skills with frontmatter metadata", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");
      const workspace = path.join(tempDir, "workspace");

      yield* writeSkill(
        path.join(configDir, "skills"),
        "codex-review",
        [
          "---",
          "name: codex-review",
          "description: Ask Codex for a review.",
          "---",
          "",
          "# Body",
        ].join("\n"),
      );
      yield* writeSkill(
        path.join(workspace, ".claude", "skills"),
        "deploy",
        ["---", "name: deploy", "description: Deploy the app.", "---", "", "# Deploy"].join("\n"),
      );

      const skills = yield* discoverClaudeSkills({ homePath: configDir }, workspace);

      assert.deepEqual(skills, [
        {
          name: "codex-review",
          path: path.join(configDir, "skills", "codex-review", "SKILL.md"),
          enabled: true,
          scope: "user",
          description: "Ask Codex for a review.",
        },
        {
          name: "deploy",
          path: path.join(workspace, ".claude", "skills", "deploy", "SKILL.md"),
          enabled: true,
          scope: "project",
          sourceCwd: path.resolve(workspace),
          description: "Deploy the app.",
        },
      ]);
    }),
  );

  it.effect("discovers project skills from the workspace .agents directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");
      const workspace = path.join(tempDir, "workspace");

      yield* writeSkill(
        path.join(workspace, ".agents", "skills"),
        "review",
        ["---", "name: review", "description: Review the changes.", "---"].join("\n"),
      );

      const skills = yield* discoverClaudeSkills({ homePath: configDir }, workspace);

      assert.deepEqual(skills, [
        {
          name: "review",
          path: path.join(workspace, ".agents", "skills", "review", "SKILL.md"),
          enabled: true,
          scope: "project",
          sourceCwd: path.resolve(workspace),
          description: "Review the changes.",
        },
      ]);
    }),
  );

  it.effect("prefers workspace .claude skills over .agents within one workspace", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");
      const workspace = path.join(tempDir, "workspace");

      yield* writeSkill(
        path.join(configDir, "skills"),
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

      const skills = yield* discoverClaudeSkills({ homePath: configDir }, workspace);

      // The project bag collapses to `.claude`; the user entry stays alongside
      // it, and the client-side filter picks project over user.
      assert.deepEqual(
        skills.map((entry) => [entry.scope, entry.sourceCwd, entry.path]),
        [
          ["user", undefined, path.join(configDir, "skills", "deploy", "SKILL.md")],
          [
            "project",
            path.resolve(workspace),
            path.join(workspace, ".claude", "skills", "deploy", "SKILL.md"),
          ],
        ],
      );
    }),
  );

  it.effect("tags multi-workspace project skills without leaking names across bags", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");
      const workspaceA = path.join(tempDir, "workspace-a");
      const workspaceB = path.join(tempDir, "workspace-b");

      yield* writeSkill(
        path.join(configDir, "skills"),
        "user-tool",
        ["---", "name: user-tool", "description: User tool.", "---"].join("\n"),
      );
      yield* writeSkill(
        path.join(workspaceA, ".claude", "skills"),
        "deploy",
        ["---", "name: deploy", "description: Deploy A.", "---"].join("\n"),
      );
      yield* writeSkill(
        path.join(workspaceB, ".claude", "skills"),
        "deploy",
        ["---", "name: deploy", "description: Deploy B.", "---"].join("\n"),
      );

      const skills = yield* discoverClaudeSkills({ homePath: configDir }, [workspaceA, workspaceB]);
      assert.deepEqual(
        skills.map((entry) => [entry.name, entry.sourceCwd, entry.description]),
        [
          ["deploy", path.resolve(workspaceA), "Deploy A."],
          ["deploy", path.resolve(workspaceB), "Deploy B."],
          ["user-tool", undefined, "User tool."],
        ],
      );
    }),
  );

  it.effect("keeps user and project skills with the same name as separate inventory entries", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");
      const workspace = path.join(tempDir, "workspace");

      yield* writeSkill(
        path.join(configDir, "skills"),
        "deploy",
        ["---", "name: deploy", "description: User deploy.", "---"].join("\n"),
      );
      yield* writeSkill(
        path.join(workspace, ".claude", "skills"),
        "deploy",
        ["---", "name: deploy", "description: Project deploy.", "---"].join("\n"),
      );

      const skills = yield* discoverClaudeSkills({ homePath: configDir }, workspace);

      // Client-side filterProviderSkillsForWorkspace lets project win by name.
      assert.deepEqual(
        skills.map((entry) => [entry.scope, entry.sourceCwd, entry.description]),
        [
          ["user", undefined, "User deploy."],
          ["project", path.resolve(workspace), "Project deploy."],
        ],
      );
    }),
  );

  it.effect("falls back to the directory name and skips malformed frontmatter", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");
      const skillsDir = path.join(configDir, "skills");

      yield* writeSkill(skillsDir, "no-frontmatter", "# Just a heading\n");
      yield* writeSkill(skillsDir, "broken-yaml", "---\nname: [unclosed\n---\n");
      // A stray file (not a directory with SKILL.md) must be skipped.
      yield* fs.makeDirectory(skillsDir, { recursive: true });
      yield* fs.writeFileString(path.join(skillsDir, "README.md"), "not a skill");

      const skills = yield* discoverClaudeSkills({ homePath: configDir }, undefined);

      // A skill with no frontmatter falls back to its directory name; a skill
      // whose frontmatter fails to parse is skipped entirely (Claude Code
      // won't load it either).
      assert.deepEqual(
        skills.map((skill) => skill.name),
        ["no-frontmatter"],
      );
      assert.equal(skills[0]?.description, undefined);
    }),
  );

  it.effect("honors CLAUDE_CONFIG_DIR from the environment when homePath is unset", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const environmentConfigDir = path.join(tempDir, "env-config");

      yield* writeSkill(
        path.join(environmentConfigDir, "skills"),
        "env-skill",
        ["---", "name: env-skill", "description: From env config dir.", "---"].join("\n"),
      );

      const skills = yield* discoverClaudeSkills({ homePath: "" }, undefined, {
        CLAUDE_CONFIG_DIR: environmentConfigDir,
      });

      assert.deepEqual(
        skills.map((skill) => skill.name),
        ["env-skill"],
      );

      // An explicit homePath wins over the environment variable, matching
      // makeClaudeEnvironment which overwrites CLAUDE_CONFIG_DIR for the CLI.
      const explicitHome = path.join(tempDir, "explicit-home");
      yield* writeSkill(
        path.join(explicitHome, "skills"),
        "explicit-skill",
        ["---", "name: explicit-skill", "---"].join("\n"),
      );
      const explicitSkills = yield* discoverClaudeSkills({ homePath: explicitHome }, undefined, {
        CLAUDE_CONFIG_DIR: environmentConfigDir,
      });
      assert.deepEqual(
        explicitSkills.map((skill) => skill.name),
        ["explicit-skill"],
      );
    }),
  );

  it.effect("resolves a relative CLAUDE_CONFIG_DIR against the workspace cwd", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const workspace = path.join(tempDir, "workspace");
      yield* fs.makeDirectory(workspace, { recursive: true });

      // The spawned CLI resolves a relative CLAUDE_CONFIG_DIR against its own
      // cwd (the workspace), so discovery must do the same.
      yield* writeSkill(
        path.join(workspace, "relative-config", "skills"),
        "relative-skill",
        ["---", "name: relative-skill", "---"].join("\n"),
      );

      const skills = yield* discoverClaudeSkills({ homePath: "" }, workspace, {
        CLAUDE_CONFIG_DIR: "relative-config",
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
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });

      const skills = yield* discoverClaudeSkills(
        { homePath: path.join(tempDir, "missing-home") },
        path.join(tempDir, "missing-workspace"),
      );

      assert.deepEqual(skills, []);
    }),
  );

  it.effect("discovers project skills from git root when cwd is nested", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");
      const repo = path.join(tempDir, "repo");
      const nested = path.join(repo, "packages", "app");
      yield* fs.makeDirectory(path.join(repo, ".git"), { recursive: true });
      yield* fs.makeDirectory(nested, { recursive: true });

      yield* writeSkill(
        path.join(repo, ".claude", "skills"),
        "root-skill",
        ["---", "name: root-skill", "description: From project root.", "---"].join("\n"),
      );

      const skills = yield* discoverClaudeSkills({ homePath: configDir }, nested);
      assert.ok(skills.some((skill) => skill.name === "root-skill"));
      assert.equal(skills.find((skill) => skill.name === "root-skill")?.scope, "project");
    }),
  );

  it.effect("prefers nearer-cwd project skill over git-root skill on name collision", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");
      const repo = path.join(tempDir, "repo");
      const nested = path.join(repo, "packages", "app");
      yield* fs.makeDirectory(path.join(repo, ".git"), { recursive: true });
      yield* fs.makeDirectory(nested, { recursive: true });

      yield* writeSkill(
        path.join(repo, ".claude", "skills"),
        "shared",
        ["---", "name: shared", "description: From git root.", "---"].join("\n"),
      );
      yield* writeSkill(
        path.join(nested, ".claude", "skills"),
        "shared",
        ["---", "name: shared", "description: From nested cwd.", "---"].join("\n"),
      );

      const skills = yield* discoverClaudeSkills({ homePath: configDir }, nested);
      const shared = skills.find((skill) => skill.name === "shared");
      assert.equal(shared?.description, "From nested cwd.");
      assert.ok(shared?.path.includes(`${path.sep}packages${path.sep}app${path.sep}`));
    }),
  );

  it.effect("discovers project skills across multiple workspace roots", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");
      const projectA = path.join(tempDir, "project-a");
      const projectB = path.join(tempDir, "project-b");
      yield* fs.makeDirectory(path.join(projectA, ".git"), { recursive: true });
      yield* fs.makeDirectory(path.join(projectB, ".git"), { recursive: true });

      yield* writeSkill(
        path.join(projectA, ".claude", "skills"),
        "skill-a",
        ["---", "name: skill-a", "description: From project A.", "---"].join("\n"),
      );
      yield* writeSkill(
        path.join(projectB, ".claude", "skills"),
        "skill-b",
        ["---", "name: skill-b", "description: From project B.", "---"].join("\n"),
      );

      const skills = yield* discoverClaudeSkills({ homePath: configDir }, [projectA, projectB]);
      assert.ok(skills.some((skill) => skill.name === "skill-a"));
      assert.ok(skills.some((skill) => skill.name === "skill-b"));
    }),
  );
});
