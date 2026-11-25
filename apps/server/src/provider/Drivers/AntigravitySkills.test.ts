import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { discoverAntigravitySkills } from "./AntigravitySkills.ts";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";

const writeSkill = Effect.fn("writeSkill")(function* (directory: string, contents: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(directory, { recursive: true });
  const skillPath = path.join(directory, "SKILL.md");
  yield* fileSystem.writeFileString(skillPath, contents);
  return skillPath;
});

const makeWorkspace = Effect.fn("makeWorkspace")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const temporaryDirectory = yield* fileSystem.makeTempDirectoryScoped({
    prefix: "t3-antigravity-skills-",
  });
  return {
    cwd: path.join(temporaryDirectory, "workspace"),
    userHome: path.join(temporaryDirectory, "home"),
    profileDirectory: path.join(temporaryDirectory, "profile"),
  };
});

it.layer(NodeServices.layer)("discoverAntigravitySkills", (it) => {
  it.effect("does not read user skills from a nested project or from ~/.agents", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const input = yield* makeWorkspace();
      const nested = { ...input, cwd: path.join(input.userHome, "AI", "Projects", "Something") };
      const skillPath = yield* writeSkill(
        path.join(input.userHome, ".gemini", "config", "skills", "review"),
        "---\nname: review\ndescription: Review changes.\n---\n",
      );
      yield* writeSkill(
        path.join(input.userHome, ".agents", "skills", "ignored"),
        "---\nname: ignored\n---\n",
      );

      assert.deepEqual(yield* discoverAntigravitySkills(nested), [
        {
          name: "review",
          description: "Review changes.",
          path: skillPath,
          scope: "user",
          enabled: true,
        },
      ]);
      assert.deepEqual(
        (yield* discoverAntigravitySkills({ ...input, cwd: input.userHome })).map((skill) => [
          skill.name,
          skill.scope,
        ]),
        [
          ["ignored", "project"],
          ["review", "user"],
        ],
      );
    }),
  );

  it.effect("reads skill names, descriptions and paths from the current native roots", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const input = yield* makeWorkspace();
      const roots = [
        { directory: path.join(input.userHome, ".gemini", "config", "skills"), scope: "user" },
        { directory: path.join(input.cwd, ".gemini", "skills"), scope: "project" },
        {
          directory: path.join(input.userHome, ".gemini", "antigravity-cli", "skills"),
          scope: "user",
        },
        { directory: path.join(input.cwd, ".agents", "skills"), scope: "project" },
      ];
      const expected = [];
      for (const [index, root] of roots.entries()) {
        const name = index === 0 ? "2026" : `review-${index}`;
        const description = index === 1 ? "1.0" : `Review changes in root ${index}.`;
        const skillPath = yield* writeSkill(
          path.join(root.directory, name),
          `---\nname: ${name}\ndescription: ${description}\n---\n# Review\n`,
        );
        expected.push({ name, description, path: skillPath, scope: root.scope, enabled: true });
      }

      assert.deepEqual(yield* discoverAntigravitySkills(input), expected);
    }),
  );

  it.effect("reads skills from enabled plugins in the instance's Antigravity profile", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspace = yield* makeWorkspace();
      const profileDirectory = path.join(workspace.userHome, "t3", "providers", "antigravity", "p");
      const plugins = path.join(profileDirectory, "config", "plugins");
      for (const plugin of ["demo", "off"]) {
        yield* writeSkill(
          path.join(plugins, plugin, "skills", `${plugin}-skill`),
          `---\nname: ${plugin}-skill\ndescription: From ${plugin}.\n---\n`,
        );
      }
      yield* fileSystem.writeFileString(
        path.join(profileDirectory, "config", "config.json"),
        JSON.stringify({ plugins: { off: { enabled: false } } }),
      );
      yield* fileSystem.writeFileString(path.join(plugins, ".DS_Store"), "x");
      const input = { ...workspace, profileDirectory };

      assert.deepEqual(
        (yield* discoverAntigravitySkills(input)).map(({ name, displayName }) => ({
          name,
          displayName,
        })),
        [{ name: "demo-skill", displayName: "demo:demo-skill" }],
      );
    }),
  );

  it.effect("uses native root order for duplicate names", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const input = yield* makeWorkspace();
      const roots = [
        path.join(input.userHome, ".gemini", "config", "skills"),
        path.join(input.cwd, ".gemini", "skills"),
        path.join(input.userHome, ".gemini", "antigravity-cli", "skills"),
        path.join(input.cwd, ".agents", "skills"),
        path.join(input.cwd, ".agent", "skills"),
      ];
      for (const [index, root] of roots.entries()) {
        yield* writeSkill(
          path.join(root, `copy-${index}`),
          `---\nname: review\ndescription: Copy ${index}.\n---\n`,
        );
      }

      for (const [index, root] of roots.entries()) {
        const skills = yield* discoverAntigravitySkills(input);
        assert.equal(skills.length, 1);
        assert.equal(skills[0]?.path, path.join(root, `copy-${index}`, "SKILL.md"));
        yield* fileSystem.remove(root, { recursive: true });
      }
    }),
  );

  it.effect("loads a root skill without scanning its children", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const input = yield* makeWorkspace();
      const root = path.join(input.cwd, ".agents", "skills");
      const skillPath = yield* writeSkill(root, "---\nname: root-skill\n---\n");
      yield* writeSkill(path.join(root, "child"), "---\nname: child-skill\n---\n");

      assert.deepEqual(yield* discoverAntigravitySkills(input), [
        { name: "root-skill", path: skillPath, scope: "project", enabled: true },
      ]);

      yield* fileSystem.writeFileString(skillPath, "---\nname: [invalid\n---\n");
      assert.deepEqual(yield* discoverAntigravitySkills(input), []);
    }),
  );

  it.effect("uses the filename when valid frontmatter has no name", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const input = yield* makeWorkspace();
      const skillPath = yield* writeSkill(
        path.join(input.cwd, ".agents", "skills", "not-the-name"),
        "---\n---\n# Skill body\n",
      );

      assert.deepEqual(yield* discoverAntigravitySkills(input), [
        { name: "SKILL", path: skillPath, scope: "project", enabled: true },
      ]);

      const lowerCasePath = path.join(path.dirname(skillPath), "skill.md");
      yield* fileSystem.rename(skillPath, lowerCasePath);
      assert.deepEqual(yield* discoverAntigravitySkills(input), [
        { name: "skill", path: lowerCasePath, scope: "project", enabled: true },
      ]);

      yield* fileSystem.rename(lowerCasePath, path.join(path.dirname(skillPath), "SKILL.MD"));
      assert.deepEqual(yield* discoverAntigravitySkills(input), []);
    }),
  );

  it.effect("accepts native metadata delimiters after leading text", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const input = yield* makeWorkspace();
      const skillPath = yield* writeSkill(
        path.join(input.cwd, ".agents", "skills", "review"),
        "Leading text.---\nname: review\ndescription: null\n---Skill body.",
      );

      assert.deepEqual(yield* discoverAntigravitySkills(input), [
        { name: "review", path: skillPath, scope: "project", enabled: true },
      ]);
    }),
  );

  it.effect("ignores invalid files and deeper directories but keeps native hidden skills", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const input = yield* makeWorkspace();
      const root = path.join(input.cwd, ".agents", "skills");
      const invalidSkills = [
        ["plain", "# Missing frontmatter\n"],
        ["broken", "---\nname: [unclosed\n---\n"],
        ["scalar", "---\n42\n---\n"],
        ["wrong-type", "---\nname: invalid\ndescription: {}\n---\n"],
        ["blank-name", '---\nname: " "\n---\n'],
      ] as const;
      for (const [name, contents] of invalidSkills) {
        yield* writeSkill(path.join(root, name), contents);
      }
      yield* writeSkill(path.join(root, "nested", "deep"), "---\nname: too-deep\n---\n");
      yield* writeSkill(
        path.join(input.cwd, ".claude", "skills", "wrong-provider"),
        "---\nname: wrong-provider\n---\n",
      );
      yield* fileSystem.makeDirectory(path.join(root, ".not-a-skill"));
      yield* fileSystem.writeFileString(path.join(root, "README.md"), "Not a skill.");
      yield* fileSystem.writeFileString(path.join(root, "SKILL.MD"), "---\nname: uppercase\n---\n");
      const skillPath = yield* writeSkill(
        path.join(root, ".native-hidden-skill"),
        "---\nname: native-name\ndescription: >\n  Review the code\n  and run tests.\n---\n",
      );

      assert.deepEqual(yield* discoverAntigravitySkills(input), [
        {
          name: "native-name",
          description: "Review the code and run tests.",
          path: skillPath,
          scope: "project",
          enabled: true,
        },
      ]);
    }),
  );

  it.effect("uses native URI order within a root and skips an invalid higher root", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const input = yield* makeWorkspace();
      const root = path.join(input.cwd, ".agents", "skills");
      yield* writeSkill(
        path.join(input.userHome, ".gemini", "config", "skills", "review"),
        "---\nname: [invalid\n---\n",
      );
      const nativeOrder = [" space-copy", "!-copy", "ø-copy", "a-copy"];
      for (const name of nativeOrder) {
        yield* writeSkill(path.join(root, name), "---\nname: review\n---\n");
      }

      for (const name of nativeOrder) {
        assert.deepEqual(yield* discoverAntigravitySkills(input), [
          {
            name: "review",
            path: path.join(root, name, "SKILL.md"),
            scope: "project",
            enabled: true,
          },
        ]);
        yield* fileSystem.remove(path.join(root, name), { recursive: true });
      }
    }),
  );

  it.effect.skipIf(!symlinksSupported)(
    "follows directory symlinks used to install shared skills",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const input = yield* makeWorkspace();
        const sourceDirectory = path.join(input.userHome, "shared-review");
        yield* writeSkill(sourceDirectory, "---\nname: review\n---\n");
        const root = path.join(input.cwd, ".agents", "skills");
        const linkedDirectory = path.join(root, "review");
        yield* fileSystem.makeDirectory(root, { recursive: true });
        yield* fileSystem.symlink(sourceDirectory, linkedDirectory);

        assert.deepEqual(yield* discoverAntigravitySkills(input), [
          {
            name: "review",
            path: path.join(linkedDirectory, "SKILL.md"),
            scope: "project",
            enabled: true,
          },
        ]);
      }),
  );

  it.effect("does not spend the scan budget on skill bodies", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const input = yield* makeWorkspace();
      const root = path.join(input.userHome, ".gemini", "config", "skills");
      const expected = [];
      for (let index = 0; index < 9; index += 1) {
        const name = `large-${index}`;
        const description = `Large skill ${index}. ${"y".repeat(2_000)}`;
        const skillPath = yield* writeSkill(
          path.join(root, name),
          `---\nname: ${name}\ndescription: ${description}\n---\n${"x".repeat(950_000)}`,
        );
        expected.push({ name, description, path: skillPath, scope: "user", enabled: true });
      }

      assert.deepEqual(yield* discoverAntigravitySkills(input), expected);
    }),
  );

  it.effect("rejects frontmatter that does not close within the per-skill limit", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const input = yield* makeWorkspace();
      const root = path.join(input.cwd, ".agents", "skills");
      const largeBodyPath = yield* writeSkill(
        path.join(root, "large-body"),
        `---\nname: large-body\n---\n${"x".repeat(2_000_000)}`,
      );
      assert.deepEqual(yield* discoverAntigravitySkills(input), [
        { name: "large-body", path: largeBodyPath, scope: "project", enabled: true },
      ]);

      const skillPath = yield* writeSkill(
        path.join(root, "oversized"),
        `---\nname: oversized\ndescription: ${"x".repeat(1_000_000)}\n---\n`,
      );
      const result = yield* discoverAntigravitySkills(input).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure.reason, "scan-budget-exhausted");
        assert.equal(result.failure.path, skillPath);
      }
    }),
  );

  it.effect("bounds the total frontmatter read size across skills", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const input = yield* makeWorkspace();
      const root = path.join(input.cwd, ".agents", "skills");
      for (let index = 0; index < 9; index += 1) {
        yield* writeSkill(
          path.join(root, `large-${index}`),
          `---\nname: large-${index}\ndescription: ${"x".repeat(900_000)}\n---\n`,
        );
      }

      const result = yield* discoverAntigravitySkills(input).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure.reason, "scan-budget-exhausted");
        assert.equal(result.failure.path, path.join(root, "large-8", "SKILL.md"));
      }
    }),
  );

  it.effect(
    "reads skills declared in global and workspace skills.json with filters and inherits",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const input = yield* makeWorkspace();

        const sharedSkills = path.join(input.userHome, ".agents", "skills");
        const keptPath = yield* writeSkill(
          path.join(sharedSkills, "yagni"),
          "---\nname: yagni\ndescription: Keep it simple.\n---\n",
        );
        const experimentalPath = yield* writeSkill(
          path.join(sharedSkills, "experimental-draft"),
          "---\nname: experimental-draft\n---\n",
        );

        const inheritedSkills = path.join(input.userHome, "inherited-skills");
        const inheritedPath = yield* writeSkill(
          path.join(inheritedSkills, "linter"),
          "---\nname: linter\n---\n",
        );
        yield* writeSkill(path.join(inheritedSkills, "skipped"), "---\nname: skipped\n---\n");
        yield* writeSkill(path.join(inheritedSkills, "lint-draft"), "---\nname: lint-draft\n---\n");

        const projectSkills = path.join(input.cwd, "tools", "skills");
        const projectPath = yield* writeSkill(
          path.join(projectSkills, "deploy"),
          "---\nname: deploy\n---\n",
        );
        yield* writeSkill(path.join(projectSkills, "internal"), "---\nname: internal\n---\n");
        const releasePath = yield* writeSkill(
          path.join(projectSkills, "public"),
          "---\nname: release\n---\n",
        );
        yield* writeSkill(path.join(projectSkills, "excluded"), "---\nname: excluded-root\n---\n");
        const explicitRoot = path.join(projectSkills, "explicit");
        yield* writeSkill(path.join(explicitRoot, "child"), "---\nname: not-discovered\n---\n");
        yield* fileSystem.writeFileString(path.join(explicitRoot, "SKILL.MD"), "---\n---\n");

        // agy does not expand ~, so a ~/ entry loads nothing.
        yield* writeSkill(
          path.join(input.userHome, "tilde-skills", "tilde"),
          "---\nname: tilde\n---\n",
        );

        const globalConfigDir = path.join(input.userHome, ".gemini", "config");
        const inheritedConfigPath = path.join(input.userHome, "shared-skills.json");
        yield* fileSystem.makeDirectory(globalConfigDir, { recursive: true });
        yield* fileSystem.makeDirectory(path.join(input.cwd, ".agents"), { recursive: true });
        yield* fileSystem.writeFileString(
          inheritedConfigPath,
          JSON.stringify({
            inherits: [{ path: path.join(globalConfigDir, "skills.json") }],
            entries: [{ path: inheritedSkills }],
          }),
        );
        yield* fileSystem.writeFileString(
          path.join(globalConfigDir, "skills.json"),
          JSON.stringify({
            inherits: [{ path: inheritedConfigPath, include_only: ["linter", "lint-.*"] }],
            entries: [
              { path: sharedSkills, exclude: ["experimental-.*"] },
              { path: "~/tilde-skills" },
            ],
          }),
        );
        yield* fileSystem.writeFileString(
          path.join(input.cwd, ".agents", "skills.json"),
          JSON.stringify({
            entries: null,
            inherits: [{ path: "workspace-skills.json", include_only: null }],
          }),
        );
        yield* fileSystem.writeFileString(
          path.join(input.cwd, "workspace-skills.json"),
          JSON.stringify({
            inherits: null,
            entries: [
              { path: "tools/skills/deploy/SKILL.md", exclude: null },
              { path: "tools/skills/internal/SKILL.md", exclude: ["internal"] },
              { path: "tools/skills/public", include_only: ["public"] },
              { path: "tools/skills/excluded", exclude: ["excluded"] },
              { path: "tools/skills/excluded", include_only: ["public"] },
              { path: "tools/skills/explicit" },
            ],
          }),
        );

        assert.deepEqual(yield* discoverAntigravitySkills(input), [
          { name: "deploy", path: projectPath, scope: "project", enabled: true },
          {
            name: "experimental-draft",
            path: experimentalPath,
            scope: "user",
            enabled: true,
          },
          { name: "linter", path: inheritedPath, scope: "user", enabled: true },
          { name: "release", path: releasePath, scope: "project", enabled: true },
          {
            name: "yagni",
            description: "Keep it simple.",
            path: keptPath,
            scope: "user",
            enabled: true,
          },
        ]);
      }),
  );
});
