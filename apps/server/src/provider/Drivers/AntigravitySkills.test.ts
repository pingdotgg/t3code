import { matchInlineSkills } from "@t3tools/shared/inlineSkills";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { discoverAntigravitySkills, prepareAntigravityPluginSkills } from "./AntigravitySkills.ts";
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
        const name = `review-${index}`;
        const description = `Review changes in root ${index}.`;
        const skillPath = yield* writeSkill(
          path.join(root.directory, name),
          `---\nname: ${name}\ndescription: ${description}\n---\n# Review\n`,
        );
        expected.push({ name, description, path: skillPath, scope: root.scope, enabled: true });
      }

      assert.deepEqual(yield* discoverAntigravitySkills(input), expected);
    }),
  );

  it.effect(
    "reads enabled plugin skills without merging same-name skills from different plugins",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const input = yield* makeWorkspace();
        const config = path.join(input.userHome, ".gemini", "config");
        const expected = [];
        for (const name of ["alpha", "beta", "broken", "off", "disabled", "unregistered"]) {
          const plugin = path.join(config, "plugins", name);
          const skillPath = yield* writeSkill(
            path.join(plugin, "skills", "review"),
            "---\nname: review\ndescription: Review changes.\n---\n",
          );
          if (name !== "unregistered") {
            yield* fileSystem.writeFileString(
              path.join(plugin, "plugin.json"),
              name === "off" || name === "broken"
                ? "{ invalid"
                : JSON.stringify({
                    name: `Display ${name}`,
                    disabled: name === "beta" || name === "disabled",
                  }),
            );
          }
          if (name === "alpha" || name === "beta") {
            expected.push({
              name: `plugin:${name}:review`,
              displayName: `${name}:review`,
              description: "Review changes.",
              path: skillPath,
              scope: "user",
              enabled: true,
            });
          }
        }
        yield* fileSystem.writeFileString(
          path.join(config, "config.json"),
          JSON.stringify({ plugins: { beta: { enabled: true }, off: { enabled: false } } }),
        );
        for (const [directory, scope] of [
          [path.join(input.cwd, ".agents", "skills"), "project"],
          [path.join(input.userHome, ".gemini", "config", "skills"), "user"],
        ] as const) {
          const name = `standalone-${scope}`;
          const skillPath = yield* writeSkill(
            path.join(directory, name),
            `---\nname: ${name}\n---\n`,
          );
          expected.push({ name, path: skillPath, scope, enabled: true });
        }
        assert.deepEqual(yield* discoverAntigravitySkills(input), expected);
        const directories = yield* prepareAntigravityPluginSkills({
          userHome: input.userHome,
          runtimeTempDirectory: yield* fileSystem.makeTempDirectoryScoped(),
        });
        const nativeSkills = yield* discoverAntigravitySkills({
          cwd: directories[0]!,
          userHome: path.join(input.userHome, "empty"),
        });
        assert.deepEqual(
          nativeSkills.map((skill) => skill.name),
          ["plugin:alpha:review", "plugin:beta:review"],
        );
        for (const [index, skill] of nativeSkills.entries()) {
          assert.include(
            yield* fileSystem.readFileString(skill.path),
            JSON.stringify(expected[index]!.path),
          );
          assert.equal(
            directories[index + 1],
            path.dirname(path.dirname(path.dirname(expected[index]!.path))),
          );
          assert.include(yield* fileSystem.readFileString(expected[index]!.path), "name: review\n");
        }
        for (const contents of ["{ invalid", '{"plugins":{"alpha":{"enabled":"yes"}}}']) {
          yield* fileSystem.writeFileString(path.join(config, "config.json"), contents);
          assert.deepEqual(yield* discoverAntigravitySkills(input), expected.slice(2));
        }
      }),
  );

  it.effect("keeps punctuation and prefix variants distinct and invocable", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const input = yield* makeWorkspace();
      const directories = ["foo.bar", "foo_bar", "_alpha", "plugin_alpha", "alpha"];
      for (const name of directories) {
        const plugin = path.join(input.userHome, ".gemini", "config", "plugins", name);
        yield* writeSkill(path.join(plugin, "skills", "review"), "---\nname: review\n---\n");
        yield* fileSystem.writeFileString(path.join(plugin, "plugin.json"), "{}");
      }
      const skills = yield* discoverAntigravitySkills(input);
      assert.lengthOf(skills, directories.length);
      assert.equal(
        new Set(skills.map((skill) => skill.name.toLowerCase())).size,
        directories.length,
      );
      for (const skill of skills) {
        const matches = [...matchInlineSkills("$" + skill.name, skills)];
        assert.lengthOf(matches, 1);
        assert.equal(matches[0]?.skill.path, skill.path);
      }
    }),
  );

  it.effect("preserves plugin directory case across separate homes", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const identifiers = [];
      for (const name of ["alpha", "Alpha"]) {
        const input = yield* makeWorkspace();
        const plugin = path.join(input.userHome, ".gemini", "config", "plugins", name);
        yield* writeSkill(path.join(plugin, "skills", "review"), "---\nname: review\n---\n");
        yield* fileSystem.writeFileString(path.join(plugin, "plugin.json"), "{}");
        identifiers.push(...(yield* discoverAntigravitySkills(input)).map((skill) => skill.name));
      }
      assert.deepEqual(identifiers, ["plugin:alpha:review", "plugin:_41_lpha:review"]);
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

  it.effect("rejects an oversized skill instead of returning an incomplete catalog", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const input = yield* makeWorkspace();
      const skillPath = yield* writeSkill(
        path.join(input.cwd, ".agents", "skills", "oversized"),
        `---\nname: oversized\ndescription: Read a large skill.\n---\n${"x".repeat(1_000_000)}`,
      );

      const result = yield* discoverAntigravitySkills(input).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure.reason, "scan-budget-exhausted");
        assert.equal(result.failure.path, skillPath);
      }
    }),
  );

  it.effect("bounds the total read size across skills", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const input = yield* makeWorkspace();
      const root = path.join(input.cwd, ".agents", "skills");
      for (let index = 0; index < 9; index += 1) {
        yield* writeSkill(
          path.join(root, `large-${index}`),
          `---\nname: large-${index}\n---\n${"x".repeat(900_000)}`,
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
});
