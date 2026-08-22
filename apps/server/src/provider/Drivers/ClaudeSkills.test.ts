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
          description: "Review the changes.",
        },
      ]);
    }),
  );

  it.effect("prefers workspace .claude skills on three-way name collisions", () =>
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
          path: path.join(workspace, ".claude", "skills", "deploy", "SKILL.md"),
          enabled: true,
          scope: "project",
          description: "Claude deploy.",
        },
      ]);
    }),
  );

  it.effect("prefers workspace .agents skills over user skills on name collisions", () =>
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

      const skills = yield* discoverClaudeSkills({ homePath: configDir }, workspace);

      assert.deepEqual(skills, [
        {
          name: "deploy",
          path: path.join(workspace, ".agents", "skills", "deploy", "SKILL.md"),
          enabled: true,
          scope: "project",
          description: "Agents deploy.",
        },
      ]);
    }),
  );

  it.effect("prefers project skills over user skills on name collisions", () =>
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

      assert.equal(skills.length, 1);
      assert.equal(skills[0]?.scope, "project");
      assert.equal(skills[0]?.description, "Project deploy.");
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

  it.effect("names installed plugin skills `<plugin>:<skill>` across all three layouts", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");
      const pluginsDir = path.join(configDir, "plugins");

      // Layout 1: a cached install, addressed by `installPath`.
      const cached = path.join(pluginsDir, "cache", "shop", "cached", "1.0.0");
      yield* writeSkill(path.join(cached, "skills"), "build", "---\nname: build\n---\n");

      // Layout 2: a plugin inside a marketplace checkout. The stale
      // `installPath` left behind still exists and still has a `skills`
      // directory — it just holds no skill, so the search must go on.
      const shop = path.join(pluginsDir, "marketplaces", "shop");
      yield* writeSkill(path.join(shop, "plugins", "nested", "skills"), "ship", "---\n---\n");
      yield* fs.makeDirectory(path.join(tempDir, "stale", "skills", "leftover"), {
        recursive: true,
      });

      // Layout 3: a marketplace whose root *is* the plugin.
      const flat = path.join(pluginsDir, "marketplaces", "flat");
      yield* writeSkill(path.join(flat, "skills"), "audit", "---\nname: audit\n---\n");

      // Written as literal JSON rather than built with JSON.stringify, which
      // the repo's `preferSchemaOverJson` rule rejects. `stale` and `gone` are
      // the installPath a directory-sourced marketplace leaves behind — one
      // still on disk, one deleted — and `empty@nowhere` is installed but
      // ships no skills from a marketplace nothing knows about.
      const json = (value: string) => value.replaceAll("'", '"');
      yield* fs.writeFileString(
        path.join(pluginsDir, "installed_plugins.json"),
        json(`{'plugins':{
          'cached@shop':[{'installPath':'${cached}'}],
          'nested@shop':[{'installPath':'${path.join(tempDir, "stale")}'}],
          'flat@flat':[{'installPath':'${path.join(tempDir, "gone")}'}],
          'empty@nowhere':[{}]
        }}`),
      );
      yield* fs.writeFileString(
        path.join(pluginsDir, "known_marketplaces.json"),
        json(`{'shop':{'installLocation':'${shop}'},'flat':{'installLocation':'${flat}'}}`),
      );

      // A marketplace plugin nobody installed must stay out of the picker.
      yield* writeSkill(path.join(shop, "plugins", "unwanted", "skills"), "nope", "---\n---\n");

      const skills = yield* discoverClaudeSkills({ homePath: configDir }, undefined, {});

      assert.deepEqual(
        skills.map((skill) => skill.name),
        ["cached:build", "flat:audit", "nested:ship"],
      );
    }),
  );

  it.effect("discovers the skills a plugin manifest declares outside `skills/<name>`", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");
      const pluginsDir = path.join(configDir, "plugins");
      const json = (value: string) => value.replaceAll("'", '"');

      // A plugin that buckets its skills a level deeper than the conventional
      // scan reaches, and lists them in its manifest — the shape
      // `mattpocock-skills` ships.
      const bucketed = path.join(pluginsDir, "cache", "shop", "bucketed", "1.0.0");
      yield* writeSkill(
        path.join(bucketed, "skills", "engineering"),
        "tdd",
        "---\nname: tdd\n---\n",
      );
      yield* writeSkill(path.join(bucketed, "skills", "in-progress"), "draft", "---\n---\n");
      yield* fs.makeDirectory(path.join(bucketed, ".claude-plugin"), { recursive: true });
      yield* fs.writeFileString(
        path.join(bucketed, ".claude-plugin", "plugin.json"),
        json("{'skills':['./skills/engineering/tdd']}"),
      );

      // An older plugin keeps its manifest at the plugin root, and its skills
      // sit where the conventional scan already finds them.
      const rootManifest = path.join(pluginsDir, "cache", "shop", "rooted", "1.0.0");
      yield* writeSkill(path.join(rootManifest, "skills"), "wt", "---\nname: wt\n---\n");
      yield* fs.writeFileString(
        path.join(rootManifest, "plugin.json"),
        json("{'skills':['./skills/wt']}"),
      );

      // A manifest may name a folder of skills instead of one skill, and may
      // carry a bare string instead of an array.
      const folder = path.join(pluginsDir, "cache", "shop", "folder", "1.0.0");
      yield* writeSkill(path.join(folder, "extra"), "audit", "---\nname: audit\n---\n");
      yield* fs.makeDirectory(path.join(folder, ".claude-plugin"), { recursive: true });
      yield* fs.writeFileString(
        path.join(folder, ".claude-plugin", "plugin.json"),
        json("{'skills':'./extra'}"),
      );

      yield* fs.writeFileString(
        path.join(pluginsDir, "installed_plugins.json"),
        json(`{'plugins':{
          'bucketed@shop':[{'installPath':'${bucketed}'}],
          'rooted@shop':[{'installPath':'${rootManifest}'}],
          'folder@shop':[{'installPath':'${folder}'}]
        }}`),
      );

      const skills = yield* discoverClaudeSkills({ homePath: configDir }, undefined, {});

      // The declared skill reaches the picker; the undeclared one a level down
      // does not, matching what the CLI loads. A manifest that repeats a
      // conventional skill yields it once.
      assert.deepEqual(
        skills.map((skill) => skill.name),
        ["bucketed:tdd", "folder:audit", "rooted:wt"],
      );
    }),
  );

  it.effect("skips plugins switched off in settings and installs owned by another workspace", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");
      const pluginsDir = path.join(configDir, "plugins");
      const workspace = path.join(tempDir, "workspace");
      const json = (value: string) => value.replaceAll("'", '"');

      const install = Effect.fn(function* (name: string) {
        const root = path.join(pluginsDir, "cache", "shop", name, "1.0.0");
        yield* writeSkill(path.join(root, "skills"), name, `---\nname: ${name}\n---\n`);
        return root;
      });
      const on = yield* install("on");
      const off = yield* install("off");
      const mine = yield* install("mine");
      const theirs = yield* install("theirs");
      const everywhere = yield* install("everywhere");
      const here = yield* install("here");

      yield* fs.writeFileString(
        path.join(configDir, "settings.json"),
        json("{'enabledPlugins':{'on@shop':true,'off@shop':false}}"),
      );
      yield* fs.makeDirectory(path.join(workspace, ".claude"), { recursive: true });
      yield* fs.writeFileString(
        path.join(workspace, ".claude", "settings.local.json"),
        json("{'enabledPlugins':{'mine@shop':true}}"),
      );
      yield* fs.writeFileString(
        path.join(pluginsDir, "installed_plugins.json"),
        json(`{'plugins':{
          'on@shop':[{'installPath':'${on}'}],
          'off@shop':[{'installPath':'${off}'}],
          'mine@shop':[{'scope':'local','projectPath':'${workspace}','installPath':'${mine}'}],
          'theirs@shop':[{'scope':'local','projectPath':'${path.join(tempDir, "elsewhere")}','installPath':'${theirs}'}],
          'both@shop':[
            {'scope':'user','installPath':'${everywhere}'},
            {'scope':'local','projectPath':'${workspace}','installPath':'${here}'}
          ]
        }}`),
      );

      const skills = yield* discoverClaudeSkills({ homePath: configDir }, workspace, {});

      // `both@shop` is installed twice and the user entry is listed first, so
      // only picking the more specific project entry yields `here`.
      assert.deepEqual(
        skills.map((skill) => skill.name),
        ["both:here", "mine:mine", "on:on"],
      );
    }),
  );
});
