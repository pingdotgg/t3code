import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { discoverAntigravitySkills } from "./AntigravitySkills.ts";

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
    profileDirectory: path.join(temporaryDirectory, "profile"),
  };
});

it.layer(NodeServices.layer)("discoverAntigravitySkills", (it) => {
  it.effect("reads skill names, descriptions and paths from the current native roots", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const input = yield* makeWorkspace();
      const roots = [
        { directory: path.join(input.profileDirectory, "config", "skills"), scope: "user" },
        { directory: path.join(input.cwd, ".gemini", "skills"), scope: "project" },
        {
          directory: path.join(input.profileDirectory, "antigravity-cli", "skills"),
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

  it.effect("returns no skills when the native roots are missing", () =>
    Effect.gen(function* () {
      const input = yield* makeWorkspace();
      assert.deepEqual(yield* discoverAntigravitySkills(input), []);
    }),
  );

  it.effect("discovers skills from the legacy workspace root", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const input = yield* makeWorkspace();
      const skillPath = yield* writeSkill(
        path.join(input.cwd, ".agent", "skills", "review"),
        "---\nname: review\ndescription: Review changes.\n---\n",
      );

      assert.deepEqual(yield* discoverAntigravitySkills(input), [
        {
          name: "review",
          description: "Review changes.",
          path: skillPath,
          scope: "project",
          enabled: true,
        },
      ]);
    }),
  );

  it.effect("uses native root order for duplicate names", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const input = yield* makeWorkspace();
      const roots = [
        path.join(input.profileDirectory, "config", "skills"),
        path.join(input.cwd, ".gemini", "skills"),
        path.join(input.profileDirectory, "antigravity-cli", "skills"),
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
        path.join(input.profileDirectory, "config", "skills", "review"),
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

  it.effect("follows directory symlinks used to install shared skills", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const input = yield* makeWorkspace();
      const sourceDirectory = path.join(input.profileDirectory, "shared-review");
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
