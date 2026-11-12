import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { discoverClaudeSkills } from "./ClaudeSkills.ts";
import { planClaudeSkillDispatch } from "./ClaudeSkillDispatch.ts";

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
  it.effect("discovers enabled plugin skills with manifest names and ignores skill overrides", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");
      const plugin = path.join(configDir, "plugins", "cache", "shop", "plugin", "1.0.0");
      const disabled = path.join(configDir, "plugins", "disabled");
      yield* writeSkill(path.join(disabled, "skills"), "hidden", "# Hidden");
      yield* writeSkill(path.join(plugin, "skills"), "plain", "# Plain");
      yield* writeSkill(
        path.join(plugin, "engineering"),
        "review",
        "---\nname: review-alias\ndescription: Review changes.\ndisable-model-invocation: true\nuser-invocable: false\n---\n",
      );
      yield* fs.makeDirectory(path.join(plugin, ".claude-plugin"), { recursive: true });
      yield* fs.writeFileString(
        path.join(plugin, ".claude-plugin", "plugin.json"),
        '{"name":"manifest-plugin","skills":["./engineering/review"]}',
      );
      yield* fs.writeFileString(
        path.join(configDir, "plugins", "installed_plugins.json"),
        JSON.stringify({
          plugins: {
            "plugin@shop": [{ scope: "user", installPath: plugin }],
            "disabled@shop": [{ scope: "user", installPath: disabled }],
            "unconfigured@shop": [{ scope: "user", installPath: disabled }],
          },
        }),
      );
      yield* fs.writeFileString(
        path.join(configDir, "settings.json"),
        '{"enabledPlugins":{"plugin@shop":true,"disabled@shop":false,"uninstalled@shop":true,"other@shop":["^1.0.0"]},"skillOverrides":{"manifest-plugin:plain":"off"}}',
      );

      const skills = yield* discoverClaudeSkills({ homePath: configDir });
      assert.deepEqual(skills, [
        {
          name: "manifest-plugin:plain",
          path: path.join(plugin, "skills", "plain", "SKILL.md"),
          enabled: true,
          scope: "user",
        },
        {
          name: "manifest-plugin:review-alias",
          path: path.join(plugin, "engineering", "review", "SKILL.md"),
          enabled: true,
          scope: "user",
          description: "Review changes.",
          userInvocationOnly: true,
          userInvocable: false,
        },
      ]);
    }),
  );
  it.effect("merges plugin enablement and selects installs in native registry order", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");
      const workspace = path.join(tempDir, "workspace");
      const nestedWorkspace = path.join(workspace, "packages", "app");
      const aliasedWorkspace = path.join(tempDir, "aliased-workspace");
      const userInstall = path.join(configDir, "plugins", "user");
      const projectInstall = path.join(configDir, "plugins", "project");
      const localInstall = path.join(configDir, "plugins", "local");
      const managedInstall = path.join(configDir, "plugins", "managed");
      yield* fs.makeDirectory(path.join(workspace, ".git"), { recursive: true });
      yield* fs.makeDirectory(nestedWorkspace, { recursive: true });
      yield* fs.symlink(workspace, aliasedWorkspace);
      for (const install of [userInstall, projectInstall, localInstall, managedInstall]) {
        yield* writeSkill(path.join(install, "skills"), "review", "# Review");
      }
      yield* fs.writeFileString(
        path.join(configDir, "plugins", "installed_plugins.json"),
        JSON.stringify({
          plugins: {
            "plugin@shop": [
              { scope: "project", projectPath: aliasedWorkspace, installPath: localInstall },
              { scope: "project", projectPath: workspace, installPath: projectInstall },
              { scope: "user", installPath: userInstall },
              { scope: "managed", installPath: managedInstall },
            ],
            "local@shop": [
              { scope: "local", projectPath: workspace, installPath: localInstall },
              { scope: "project", projectPath: workspace, installPath: projectInstall },
              { scope: "managed", installPath: path.join(configDir, "plugins", "missing") },
              { scope: "managed", installPath: managedInstall },
              { scope: "user", installPath: userInstall },
            ],
          },
        }),
      );
      yield* fs.writeFileString(
        path.join(configDir, "settings.json"),
        '{"enabledPlugins":{"plugin@shop":true,"local@shop":false}}',
      );
      yield* fs.makeDirectory(path.join(workspace, ".claude"), { recursive: true });
      yield* fs.writeFileString(
        path.join(workspace, ".claude", "settings.json"),
        '{"enabledPlugins":{"plugin@shop":false,"local@shop":true,"other@shop":["^1.0.0"]}}',
      );
      const projectSettings = yield* discoverClaudeSkills({ homePath: configDir }, workspace);
      assert.deepEqual(
        projectSettings.map((skill) => [skill.name, skill.scope, skill.path]),
        [["local:review", "project", path.join(localInstall, "skills", "review", "SKILL.md")]],
      );
      assert.deepEqual(
        (yield* discoverClaudeSkills({ homePath: configDir }, nestedWorkspace)).map((skill) => [
          skill.name,
          skill.scope,
          skill.path,
        ]),
        [["plugin:review", "project", path.join(projectInstall, "skills", "review", "SKILL.md")]],
      );
      yield* fs.writeFileString(
        path.join(workspace, ".claude", "settings.local.json"),
        '{"enabledPlugins":{"plugin@shop":true,"local@shop":false},"skillOverrides":{"invalid":"bogus"}}',
      );
      assert.deepEqual(
        yield* discoverClaudeSkills({ homePath: configDir }, workspace),
        projectSettings,
      );
      yield* fs.writeFileString(
        path.join(workspace, ".claude", "settings.local.json"),
        '{"enabledPlugins":{"plugin@shop":true,"local@shop":true}}',
      );
      const localSettings = yield* discoverClaudeSkills({ homePath: configDir }, workspace);
      assert.deepEqual(
        localSettings.map((skill) => [skill.name, skill.scope, skill.path]),
        [
          ["local:review", "project", path.join(localInstall, "skills", "review", "SKILL.md")],
          ["plugin:review", "project", path.join(projectInstall, "skills", "review", "SKILL.md")],
        ],
      );
      assert.deepEqual(
        yield* discoverClaudeSkills({ homePath: configDir }, nestedWorkspace),
        localSettings,
      );
      assert.deepEqual(
        yield* discoverClaudeSkills({ homePath: configDir }, aliasedWorkspace),
        localSettings,
      );
      yield* fs.writeFileString(
        path.join(workspace, ".claude", "settings.local.json"),
        '{"enabledPlugins":{"local@shop":["^1.0.0"]}}',
      );
      assert.deepEqual(yield* discoverClaudeSkills({ homePath: configDir }, workspace), []);
      yield* fs.writeFileString(
        path.join(configDir, "settings.json"),
        '{"enabledPlugins":{"plugin@shop":true,"local@shop":true}}',
      );
      const separateRepository = path.join(workspace, "separate");
      yield* fs.makeDirectory(path.join(separateRepository, ".git"), { recursive: true });
      for (const cwd of [undefined, path.join(tempDir, "elsewhere"), separateRepository]) {
        const elsewhere = yield* discoverClaudeSkills({ homePath: configDir }, cwd);
        assert.deepEqual(
          elsewhere.map((skill) => [skill.name, skill.scope, skill.path]),
          [
            ["local:review", "user", path.join(managedInstall, "skills", "review", "SKILL.md")],
            ["plugin:review", "user", path.join(userInstall, "skills", "review", "SKILL.md")],
          ],
        );
      }
      const worktree = path.join(tempDir, "worktree");
      const worktreeGitDirectory = path.join(workspace, ".git", "worktrees", "fixture");
      yield* fs.makeDirectory(worktree);
      yield* fs.makeDirectory(worktreeGitDirectory, { recursive: true });
      yield* fs.writeFileString(path.join(worktree, ".git"), `gitdir: ${worktreeGitDirectory}\n`);
      yield* fs.writeFileString(path.join(worktreeGitDirectory, "commondir"), "../..\n");
      yield* fs.writeFileString(
        path.join(worktreeGitDirectory, "gitdir"),
        path.join(worktree, ".git"),
      );
      assert.deepEqual(
        yield* discoverClaudeSkills({ homePath: configDir }, worktree),
        localSettings,
      );
      const linkedWorktree = path.join(tempDir, "linked-worktree");
      yield* fs.symlink(worktree, linkedWorktree);
      assert.deepEqual(
        yield* discoverClaudeSkills({ homePath: configDir }, linkedWorktree),
        localSettings,
      );
    }),
  );
  it.effect("resolves each install record's project repository once per discovery", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      // Real path: macOS temp dirs sit behind a /var -> /private/var symlink.
      const tempDir = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" }),
      );
      const configDir = path.join(tempDir, "claude-home");
      const workspace = path.join(tempDir, "workspace");
      const otherProject = path.join(tempDir, "other", "packages", "app");
      const sameRepoProject = path.join(workspace, "packages", "app");
      yield* fs.makeDirectory(path.join(workspace, ".git"), { recursive: true });
      yield* fs.makeDirectory(path.join(tempDir, "other", ".git"), { recursive: true });
      yield* fs.makeDirectory(otherProject, { recursive: true });
      yield* fs.makeDirectory(sameRepoProject, { recursive: true });
      const elsewhereInstall = path.join(configDir, "plugins", "elsewhere");
      const sameRepoInstall = path.join(configDir, "plugins", "same-repo");
      yield* writeSkill(path.join(elsewhereInstall, "skills"), "elsewhere", "# Elsewhere");
      yield* writeSkill(path.join(sameRepoInstall, "skills"), "same-repo", "# Same repo");
      const records = Array.from({ length: 4 }, () => ({
        scope: "project",
        projectPath: otherProject,
        installPath: elsewhereInstall,
      }));
      const plugins = ["a@shop", "b@shop", "c@shop"];
      yield* fs.writeFileString(
        path.join(configDir, "plugins", "installed_plugins.json"),
        JSON.stringify({
          plugins: {
            ...Object.fromEntries(plugins.map((key) => [key, records])),
            "d@shop": [
              { scope: "project", projectPath: sameRepoProject, installPath: sameRepoInstall },
            ],
          },
        }),
      );
      yield* fs.writeFileString(
        path.join(configDir, "settings.json"),
        JSON.stringify({
          enabledPlugins: Object.fromEntries([...plugins, "d@shop"].map((key) => [key, true])),
        }),
      );

      const probed: Array<string> = [];
      const skills = yield* discoverClaudeSkills({ homePath: configDir }, workspace).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          exists: (target) => {
            probed.push(target);
            return fs.exists(target);
          },
        }),
      );
      assert.strictEqual(
        probed.filter((target) => target === path.join(otherProject, ".git")).length,
        1,
      );
      assert.deepEqual(
        skills.map((skill) => skill.name),
        ["d:same-repo"],
      );
    }),
  );
  it.effect("publishes and dispatches canonical plugin folder names regardless of aliases", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const configDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const plugin = path.join(configDir, "plugins", "installed");
      yield* writeSkill(path.join(plugin, "skills"), "review", "---\nname: review-alias\n---\n");
      yield* writeSkill(path.join(plugin, "skills"), "alias", "---\nname: dot.alias\n---\n");
      yield* fs.writeFileString(
        path.join(configDir, "plugins", "installed_plugins.json"),
        JSON.stringify({ plugins: { "plugin@shop": [{ scope: "user", installPath: plugin }] } }),
      );
      yield* fs.writeFileString(
        path.join(configDir, "settings.json"),
        '{"enabledPlugins":{"plugin@shop":true}}',
      );

      const skills = yield* discoverClaudeSkills({ homePath: configDir });
      assert.deepEqual(
        planClaudeSkillDispatch(
          "$plugin:alias focus on auth",
          new Map(skills.map((skill) => [skill.name, skill])),
        ),
        {
          leadingText: undefined,
          commandText: "/plugin:alias focus on auth",
        },
      );
      assert.deepEqual(
        skills.map((skill) => skill.name),
        ["plugin:alias", "plugin:review"],
      );
    }),
  );
  it.effect("uses the native cache root, root-skill fallback and manifest path boundaries", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const configDir = path.join(workspace, "config");
      const pluginsDir = path.join(workspace, "plugin-cache");
      const plugin = path.join(pluginsDir, "installed");
      const outside = path.join(workspace, "outside");
      yield* writeSkill(pluginsDir, "installed", "---\nname: plugin:root.alias\n---\n");
      yield* fs.makeDirectory(configDir);
      yield* fs.writeFileString(
        path.join(configDir, "settings.json"),
        '{"enabledPlugins":{"plugin@shop":true}}',
      );
      yield* fs.writeFileString(
        path.join(pluginsDir, "installed_plugins.json"),
        JSON.stringify({ plugins: { "plugin@shop": [{ scope: "user", installPath: plugin }] } }),
      );
      const environment = { CLAUDE_CODE_PLUGIN_CACHE_DIR: "plugin-cache" };
      assert.deepEqual(
        (yield* discoverClaudeSkills({ homePath: configDir }, workspace, environment)).map(
          (skill) => skill.name,
        ),
        ["plugin:root-alias"],
      );

      yield* writeSkill(path.join(plugin, "skills"), "plain", "# Plain");
      yield* writeSkill(plugin, "custom", "---\nname: custom.review\n---\n");
      yield* writeSkill(outside, "escaped", "# Outside");
      yield* fs.symlink(outside, path.join(plugin, "escape"));
      yield* fs.makeDirectory(path.join(plugin, ".claude-plugin"));
      yield* fs.writeFileString(
        path.join(plugin, ".claude-plugin", "plugin.json"),
        '{"skills":["./custom","./escape","../../outside"]}',
      );
      assert.deepEqual(
        (yield* discoverClaudeSkills({ homePath: configDir }, workspace, environment)).map(
          (skill) => skill.name,
        ),
        ["plugin:custom-review", "plugin:plain"],
      );
    }),
  );
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
          description: "Deploy the app.",
        },
      ]);
    }),
  );
  it.effect("discovers skills from the instance's --add-dir launch args", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");
      const workspace = path.join(tempDir, "workspace");
      const extraDir = path.join(workspace, "extra skills");
      yield* fs.makeDirectory(workspace, { recursive: true });
      yield* writeSkill(
        path.join(extraDir, ".claude", "skills"),
        "demo",
        ["---", "description: From an additional directory.", "---"].join("\n"),
      );

      assert.deepEqual(yield* discoverClaudeSkills({ homePath: configDir }, workspace), []);
      for (const launchArgs of [
        `--add-dir "${extraDir}"`,
        `--add-dir="${extraDir}"`,
        '--add-dir "extra skills"',
        '--add-dir="extra skills"',
        `--add-dir missing --add-dir "${extraDir}"`,
        `--add-dir "${extraDir}" --add-dir missing`,
        `--add-dir missing "${extraDir}"`,
      ]) {
        const settings = { homePath: configDir, launchArgs };
        const skills = yield* discoverClaudeSkills(settings, workspace);
        assert.deepEqual(skills, [
          {
            name: "demo",
            path: path.join(extraDir, ".claude", "skills", "demo", "SKILL.md"),
            enabled: true,
            scope: "project",
            description: "From an additional directory.",
          },
        ]);
      }
      const settings = { homePath: configDir, launchArgs: `--add-dir "${extraDir}"` };
      const skills = yield* discoverClaudeSkills(settings, workspace);
      assert.deepEqual(
        planClaudeSkillDispatch(
          "$demo",
          new Map(skills.map((skill) => [skill.name, { path: skill.path }])),
        ),
        {
          leadingText: undefined,
          commandText: "/demo",
        },
      );
      yield* writeSkill(
        path.join(workspace, ".claude", "skills"),
        "demo",
        "---\ndescription: Project copy.\n---",
      );
      const projectSkills = yield* discoverClaudeSkills(settings, workspace);
      assert.equal(projectSkills[0]?.description, "Project copy.");
      for (const launchArgs of ["--add-dir", '--add-dir=""', '--add-dir "extra skills"']) {
        const settings = { homePath: configDir, launchArgs };
        assert.deepEqual(yield* discoverClaudeSkills(settings), []);
      }
    }),
  );
  it.effect("prefers user skills on name collisions even with a stray .agents copy", () =>
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

      assert.deepEqual(skills, [
        {
          name: "deploy",
          path: path.join(configDir, "skills", "deploy", "SKILL.md"),
          enabled: true,
          scope: "user",
          description: "User deploy.",
        },
      ]);
    }),
  );
  it.effect("recovers colon-bearing descriptions with invocation metadata intact", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");

      for (const [description, comment] of [
        ["Browser automation + AI test authoring via kane-cli: run browser objectives, ...", ""],
        ['Read C:\\skills\\guide#tag: continue with "quoted".', " # trailing: comment"],
      ] as const) {
        yield* writeSkill(
          path.join(configDir, "skills"),
          "kane-cli",
          [
            "---",
            "name: frontmatter-alias",
            `description: ${description}${comment}`,
            "allowed-tools: [Read, Write]",
            "disable-model-invocation: yes",
            "user-invocable: no",
            "---",
          ].join("\n"),
        );

        const skills = yield* discoverClaudeSkills({ homePath: configDir }, undefined);

        assert.deepEqual(skills, [
          {
            name: "kane-cli",
            path: path.join(configDir, "skills", "kane-cli", "SKILL.md"),
            enabled: true,
            scope: "user",
            description,
            userInvocationOnly: true,
            userInvocable: false,
          },
        ]);
      }
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
      for (const [directoryName, field] of [
        ["broken-yaml", "name: [unclosed"],
        ["broken-tools", "allowed-tools: [Read, Write"],
        ["broken-quoted", 'name: "unclosed: text'],
      ] as const) {
        yield* writeSkill(
          skillsDir,
          directoryName,
          ["---", "description: Run: browser objectives.", field, "---"].join("\n"),
        );
      }
      yield* fs.makeDirectory(skillsDir, { recursive: true });
      yield* fs.writeFileString(path.join(skillsDir, "README.md"), "not a skill");

      const skills = yield* discoverClaudeSkills({ homePath: configDir }, undefined);

      // Claude falls back to directory names without frontmatter, but skips malformed frontmatter.
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

      // The CLI resolves relative CLAUDE_CONFIG_DIR against workspace cwd.
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
});

