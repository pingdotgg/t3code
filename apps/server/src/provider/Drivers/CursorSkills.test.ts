import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import {
  discoverCursorSkills,
  MAX_DIRECTORIES_PER_ROOT,
  MAX_ENTRIES_PER_ROOT,
  resolveCursorHomeDirectory,
} from "./CursorSkills.ts";

const writeSkill = Effect.fn(function* (skillDirectory: string, contents: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(skillDirectory, { recursive: true });
  yield* fs.writeFileString(path.join(skillDirectory, "SKILL.md"), contents);
});

const frontmatter = (name: string, description: string) =>
  ["---", `name: ${name}`, `description: ${description}`, "---", "", "# Body"].join("\n");

/**
 * Fixture home/workspace pair plus an environment whose `HOME` points at the
 * fixture rather than the real one, so tests never read the developer's own
 * skills.
 */
const makeFixture = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cursor-skills-" });
  const home = path.join(tempDir, "home");
  const workspace = path.join(tempDir, "workspace");
  yield* fs.makeDirectory(home, { recursive: true });
  yield* fs.makeDirectory(workspace, { recursive: true });
  return {
    tempDir,
    home,
    workspace,
    environment: { HOME: home, USERPROFILE: home } satisfies NodeJS.ProcessEnv,
    userClaude: path.join(home, ".claude", "skills"),
    userCodex: path.join(home, ".codex", "skills"),
    userCursor: path.join(home, ".cursor", "skills"),
    userAgents: path.join(home, ".agents", "skills"),
    projectClaude: path.join(workspace, ".claude", "skills"),
    projectCodex: path.join(workspace, ".codex", "skills"),
    projectCursor: path.join(workspace, ".cursor", "skills"),
    projectAgents: path.join(workspace, ".agents", "skills"),
  };
});

it.layer(NodeServices.layer)("discoverCursorSkills", (it) => {
  it.effect("merges all eight roots with project and .cursor winning collisions", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fixture = yield* makeFixture();

      for (const [root, name, description] of [
        [fixture.userClaude, "user-claude-only", "From the user .claude root."],
        [fixture.userCodex, "user-codex-only", "From the user .codex root."],
        [fixture.userAgents, "user-agents-only", "From the user .agents root."],
        [fixture.userCursor, "user-cursor-only", "From the user .cursor root."],
        [fixture.projectClaude, "project-claude-only", "From the project .claude root."],
        [fixture.projectCodex, "project-codex-only", "From the project .codex root."],
      ] as const) {
        yield* writeSkill(path.join(root, name), frontmatter(name, description));
      }

      // Same name in every root: the highest-precedence one must win, and the
      // row must appear exactly once.
      for (const [root, description] of [
        [fixture.userClaude, "user claude"],
        [fixture.userCodex, "user codex"],
        [fixture.userAgents, "user agents"],
        [fixture.userCursor, "user cursor"],
        [fixture.projectClaude, "project claude"],
        [fixture.projectCodex, "project codex"],
        [fixture.projectAgents, "project agents"],
        [fixture.projectCursor, "project cursor"],
      ] as const) {
        yield* writeSkill(path.join(root, "everywhere"), frontmatter("everywhere", description));
      }

      // Same scope, different roots: `.cursor` beats `.agents`.
      for (const [root, description] of [
        [fixture.projectClaude, "project claude"],
        [fixture.projectCodex, "project codex"],
        [fixture.projectAgents, "project agents"],
        [fixture.projectCursor, "project cursor"],
      ] as const) {
        yield* writeSkill(path.join(root, "same-scope"), frontmatter("same-scope", description));
      }

      for (const [name, roots] of [
        [
          "compat-precedence",
          [
            [fixture.projectClaude, "project claude"],
            [fixture.projectCodex, "project codex"],
          ],
        ],
        [
          "portable-precedence",
          [
            [fixture.projectCodex, "project codex"],
            [fixture.projectAgents, "project agents"],
          ],
        ],
      ] as const) {
        for (const [root, description] of roots) {
          yield* writeSkill(path.join(root, name), frontmatter(name, description));
        }
      }
      // Organizational category directory nested inside a root.
      yield* writeSkill(
        path.join(fixture.projectCursor, "shipping", "land-it"),
        frontmatter("land-it", "Nested under a category directory."),
      );

      const skills = yield* discoverCursorSkills(fixture.workspace, fixture.environment);

      assert.deepEqual(
        skills.map((skill) => [skill.name, skill.scope, skill.description]),
        [
          ["compat-precedence", "project", "project codex"],
          ["everywhere", "project", "project cursor"],
          ["land-it", "project", "Nested under a category directory."],
          ["portable-precedence", "project", "project agents"],
          ["project-claude-only", "project", "From the project .claude root."],
          ["project-codex-only", "project", "From the project .codex root."],
          ["same-scope", "project", "project cursor"],
          ["user-agents-only", "user", "From the user .agents root."],
          ["user-claude-only", "user", "From the user .claude root."],
          ["user-codex-only", "user", "From the user .codex root."],
          ["user-cursor-only", "user", "From the user .cursor root."],
        ],
      );
      assert.equal(
        skills.find((skill) => skill.name === "land-it")?.path,
        path.join(fixture.projectCursor, "shipping", "land-it", "SKILL.md"),
      );
      assert.isTrue(skills.every((skill) => skill.enabled));
    }),
  );

  it.effect("resolves inventory per working directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const fixture = yield* makeFixture();
      const otherWorkspace = path.join(fixture.tempDir, "other-workspace");
      yield* fs.makeDirectory(otherWorkspace, { recursive: true });

      yield* writeSkill(path.join(fixture.userCursor, "shared"), frontmatter("shared", "user"));
      yield* writeSkill(path.join(fixture.projectCursor, "only-a"), frontmatter("only-a", "A"));
      yield* writeSkill(
        path.join(otherWorkspace, ".cursor", "skills", "shared"),
        frontmatter("shared", "overridden by B"),
      );

      const first = yield* discoverCursorSkills(fixture.workspace, fixture.environment);
      const second = yield* discoverCursorSkills(otherWorkspace, fixture.environment);

      assert.deepEqual(
        first.map((skill) => [skill.name, skill.description]),
        [
          ["only-a", "A"],
          ["shared", "user"],
        ],
      );
      assert.deepEqual(
        second.map((skill) => [skill.name, skill.description]),
        [["shared", "overridden by B"]],
      );
    }),
  );

  /**
   * `cursor-agent` 2026.07.20-8cc9c0b loads every one of these. It names a
   * skill after its directory and derives a missing description from the
   * body's first heading, so none of them may be dropped.
   */
  it.effect("keeps skills Cursor itself loads despite loose frontmatter", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fixture = yield* makeFixture();

      yield* writeSkill(
        path.join(fixture.projectCursor, "mismatched-dir"),
        frontmatter("renamed-skill", "Frontmatter name disagrees with the directory."),
      );
      yield* writeSkill(
        path.join(fixture.projectCursor, "no-desc"),
        ["---", "name: no-desc", "---", "", "# No description probe", "", "Body."].join("\n"),
      );
      yield* writeSkill(
        path.join(fixture.projectCursor, "no-frontmatter"),
        ["# No frontmatter probe", "", "Body."].join("\n"),
      );
      yield* writeSkill(
        path.join(fixture.projectCursor, "Weird_Name"),
        frontmatter("Weird_Name", "Non-conforming characters still load."),
      );
      yield* writeSkill(
        path.join(fixture.projectCursor, "unterminated"),
        ["---", "name: unterminated", "description: Never closed.", "", "# Fallback"].join("\n"),
      );
      yield* writeSkill(
        path.join(fixture.projectCursor, "not-a-mapping"),
        ["---", "- just", "- a list", "---", "", "# List frontmatter"].join("\n"),
      );

      const skills = yield* discoverCursorSkills(fixture.workspace, fixture.environment);

      assert.deepEqual(
        skills.map((skill) => [skill.name, skill.description]),
        [
          ["mismatched-dir", "Frontmatter name disagrees with the directory."],
          ["no-desc", "No description probe"],
          ["no-frontmatter", "No frontmatter probe"],
          // An unterminated `---` never opens frontmatter, so the first
          // heading is whatever the body starts with.
          ["not-a-mapping", "List frontmatter"],
          ["unterminated", "Fallback"],
          ["Weird_Name", "Non-conforming characters still load."],
        ],
      );
    }),
  );

  it.effect("parses a BOM and CRLF file, and ignores a non-delimiter --- line", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fixture = yield* makeFixture();

      yield* writeSkill(
        path.join(fixture.projectCursor, "bom-crlf"),
        `\ufeff${["---", "name: bom-crlf", "description: Handles BOM and CRLF.", "---", "", "# Body"].join("\r\n")}`,
      );
      yield* writeSkill(
        path.join(fixture.projectCursor, "not-a-delimiter"),
        ["--- not a delimiter", "name: ignored", "---", "", "# Real heading"].join("\n"),
      );

      const skills = yield* discoverCursorSkills(fixture.workspace, fixture.environment);

      assert.deepEqual(
        skills.map((skill) => [skill.name, skill.description]),
        [
          ["bom-crlf", "Handles BOM and CRLF."],
          // Frontmatter never opened, so `name: ignored` is body text and the
          // description comes from the heading.
          ["not-a-delimiter", "Real heading"],
        ],
      );
    }),
  );

  it.effect("ignores heading-like lines inside fenced code blocks", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fixture = yield* makeFixture();

      yield* writeSkill(
        path.join(fixture.projectCursor, "backtick-fence"),
        ["```sh", "# install command", "```", "", "# Real heading"].join("\n"),
      );
      yield* writeSkill(
        path.join(fixture.projectCursor, "tilde-fence"),
        ["~~~md", "# rendered as code", "~~~~", "", "## Visible heading"].join("\n"),
      );
      yield* writeSkill(
        path.join(fixture.projectCursor, "unclosed-fence"),
        ["```sh", "# remains code through end of file"].join("\n"),
      );

      const skills = yield* discoverCursorSkills(fixture.workspace, fixture.environment);

      assert.deepEqual(
        skills.map((skill) => [skill.name, skill.description]),
        [
          ["backtick-fence", "Real heading"],
          ["tilde-fence", "Visible heading"],
          ["unclosed-fence", undefined],
        ],
      );
    }),
  );

  it.effect("skips only what it cannot read", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const fixture = yield* makeFixture();

      yield* writeSkill(path.join(fixture.projectCursor, "healthy"), frontmatter("healthy", "OK."));
      // A directory with no SKILL.md is a category directory, not a skill.
      yield* fs.makeDirectory(path.join(fixture.projectCursor, "empty-category"), {
        recursive: true,
      });
      const blocked = path.join(fixture.projectCursor, "blocked");
      yield* writeSkill(path.join(blocked, "hidden"), frontmatter("hidden", "Unreachable."));
      yield* fs.chmod(blocked, 0o000);

      const skills = yield* discoverCursorSkills(fixture.workspace, fixture.environment).pipe(
        Effect.ensuring(fs.chmod(blocked, 0o700).pipe(Effect.ignore)),
      );

      assert.deepEqual(
        skills.map((skill) => skill.name),
        typeof process.getuid === "function" && process.getuid() === 0
          ? ["healthy", "hidden"]
          : ["healthy"],
      );
    }),
  );

  it.effect("reads the merged environment's home, not the process home", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fixture = yield* makeFixture();
      const otherHome = path.join(fixture.tempDir, "other-home");

      yield* writeSkill(
        path.join(fixture.userCursor, "fixture-home"),
        frontmatter("fixture-home", "Under the fixture HOME."),
      );
      yield* writeSkill(
        path.join(otherHome, ".cursor", "skills", "other-home"),
        frontmatter("other-home", "Under the overridden HOME."),
      );

      const skills = yield* discoverCursorSkills(fixture.workspace, { HOME: otherHome });

      assert.deepEqual(
        skills.map((skill) => skill.name),
        ["other-home"],
      );
    }),
  );

  it.effect("terminates on a symlinked directory cycle and sorts deterministically", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const fixture = yield* makeFixture();

      yield* writeSkill(path.join(fixture.projectCursor, "beta"), frontmatter("beta", "Beta."));
      yield* writeSkill(path.join(fixture.projectCursor, "alpha"), frontmatter("alpha", "Alpha."));
      const loopCreated = yield* fs
        .symlink(fixture.projectCursor, path.join(fixture.projectCursor, "loop"))
        .pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );

      const skills = yield* discoverCursorSkills(fixture.workspace, fixture.environment);

      assert.isTrue(loopCreated, "platform does not support symlinks");
      assert.deepEqual(
        skills.map((skill) => skill.name),
        ["alpha", "beta"],
      );
    }),
  );

  it.effect("follows a skill symlink whose canonical target stays inside the root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const fixture = yield* makeFixture();
      const target = path.join(fixture.projectCursor, "z-target");

      yield* writeSkill(target, frontmatter("z-target", "Reached through an in-root symlink."));
      yield* fs.symlink(target, path.join(fixture.projectCursor, "a-linked"));

      const skills = yield* discoverCursorSkills(fixture.workspace, fixture.environment);

      assert.deepEqual(
        skills.map((skill) => [skill.name, skill.description]),
        [["a-linked", "Reached through an in-root symlink."]],
      );
    }),
  );

  it.effect("does not follow skill roots or nested symlinks outside their scope boundary", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const fixture = yield* makeFixture();
      const outside = path.join(fixture.tempDir, "outside");
      const escapedRoot = path.join(outside, "root-skills");
      const escapedNestedSkill = path.join(outside, "nested-skill");

      yield* writeSkill(
        path.join(escapedRoot, "through-root"),
        frontmatter("through-root", "Outside through the root symlink."),
      );
      yield* writeSkill(
        escapedNestedSkill,
        frontmatter("through-child", "Outside through a nested symlink."),
      );
      yield* fs.makeDirectory(path.dirname(fixture.projectAgents), { recursive: true });
      yield* fs.makeDirectory(fixture.projectCursor, { recursive: true });
      yield* fs.symlink(escapedRoot, fixture.projectAgents);
      yield* fs.symlink(escapedNestedSkill, path.join(fixture.projectCursor, "escaped-child"));

      const skills = yield* discoverCursorSkills(fixture.workspace, fixture.environment);

      assert.isEmpty(skills);
    }),
  );

  it.effect("reads a symlinked SKILL.md only when its target stays inside the root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const fixture = yield* makeFixture();
      const inRootTarget = path.join(fixture.projectCursor, "in-root-target.md");
      const outsideTarget = path.join(fixture.tempDir, "outside-target.md");
      const inRootSkill = path.join(fixture.projectCursor, "in-root-link");
      const escapedSkill = path.join(fixture.projectCursor, "escaped-file-link");

      yield* fs.makeDirectory(inRootSkill, { recursive: true });
      yield* fs.makeDirectory(escapedSkill, { recursive: true });
      yield* fs.writeFileString(
        inRootTarget,
        frontmatter("in-root-link", "Read through an in-root file symlink."),
      );
      yield* fs.writeFileString(
        outsideTarget,
        frontmatter("escaped-file-link", "Must not escape the skill root."),
      );
      yield* fs.symlink(inRootTarget, path.join(inRootSkill, "SKILL.md"));
      yield* fs.symlink(outsideTarget, path.join(escapedSkill, "SKILL.md"));

      const skills = yield* discoverCursorSkills(fixture.workspace, fixture.environment);

      assert.deepEqual(
        skills.map((skill) => [skill.name, skill.description]),
        [["in-root-link", "Read through an in-root file symlink."]],
      );
    }),
  );

  it.effect("bounds directories visited even when none contain skills", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const fixture = yield* makeFixture();
      const directoryNames = Array.from(
        { length: MAX_DIRECTORIES_PER_ROOT + 50 },
        (_, index) => `category-${String(index).padStart(4, "0")}`,
      );
      let emptyDirectoriesRead = 0;

      yield* fs.makeDirectory(fixture.projectCursor, { recursive: true });
      const resolvedProjectCursor = yield* fs.realPath(fixture.projectCursor);
      const directoryInfo = yield* fs.stat(fixture.projectCursor);
      const instrumented = Layer.succeed(
        FileSystem.FileSystem,
        FileSystem.FileSystem.of({
          ...fs,
          readDirectory: (directory, options) => {
            const current = String(directory);
            if (current === resolvedProjectCursor) {
              return Effect.succeed(directoryNames);
            }
            if (current.startsWith(`${resolvedProjectCursor}${path.sep}`)) {
              emptyDirectoriesRead += 1;
              return Effect.succeed([]);
            }
            return fs.readDirectory(directory, options);
          },
          realPath: (filePath) => {
            const current = String(filePath);
            if (current.startsWith(`${fixture.projectCursor}${path.sep}`)) {
              return Effect.succeed(current.replace(fixture.projectCursor, resolvedProjectCursor));
            }
            return current.startsWith(`${resolvedProjectCursor}${path.sep}`)
              ? Effect.succeed(current)
              : fs.realPath(filePath);
          },
          stat: (filePath) => {
            const current = String(filePath);
            return current.startsWith(`${fixture.projectCursor}${path.sep}`) ||
              current.startsWith(`${resolvedProjectCursor}${path.sep}`)
              ? Effect.succeed(directoryInfo)
              : fs.stat(filePath);
          },
        }),
      );

      const skills = yield* discoverCursorSkills(fixture.workspace, fixture.environment).pipe(
        Effect.provide(instrumented),
      );

      assert.isEmpty(skills);
      // The root itself occupies one slot in the resolved-directory set.
      assert.equal(emptyDirectoriesRead, MAX_DIRECTORIES_PER_ROOT - 1);
    }),
  );

  it.effect("does not let a skill package's body tree starve sibling discovery", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const fixture = yield* makeFixture();
      const packageDirectory = path.join(fixture.projectCursor, "a-package");
      const childNames = Array.from(
        { length: MAX_DIRECTORIES_PER_ROOT },
        (_, index) => `asset-${String(index).padStart(4, "0")}`,
      );
      let packageChildrenStatted = 0;

      yield* writeSkill(packageDirectory, frontmatter("a-package", "Has a large asset tree."));
      yield* writeSkill(
        path.join(fixture.projectCursor, "z-sibling"),
        frontmatter("z-sibling", "Must still be discovered."),
      );

      const resolvedPackageDirectory = yield* fs.realPath(packageDirectory);
      const directoryInfo = yield* fs.stat(packageDirectory);
      const instrumented = Layer.succeed(
        FileSystem.FileSystem,
        FileSystem.FileSystem.of({
          ...fs,
          readDirectory: (directory, options) =>
            String(directory) === resolvedPackageDirectory
              ? Effect.succeed(["SKILL.md", ...childNames])
              : fs.readDirectory(directory, options),
          realPath: (filePath) => {
            const current = String(filePath);
            if (current.startsWith(`${packageDirectory}${path.sep}`)) {
              return Effect.succeed(
                path.join(resolvedPackageDirectory, path.relative(packageDirectory, current)),
              );
            }
            return fs.realPath(filePath);
          },
          stat: (filePath) => {
            const current = String(filePath);
            if (current.startsWith(`${packageDirectory}${path.sep}`)) {
              packageChildrenStatted += 1;
              return Effect.succeed(directoryInfo);
            }
            return fs.stat(filePath);
          },
        }),
      );

      const skills = yield* discoverCursorSkills(fixture.workspace, fixture.environment).pipe(
        Effect.provide(instrumented),
      );

      assert.deepEqual(
        skills.map((skill) => skill.name),
        ["a-package", "z-sibling"],
      );
      assert.equal(packageChildrenStatted, 0);
    }),
  );

  it.effect("collects the current skill before bounding child inspection in a wide directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const fixture = yield* makeFixture();
      const wideSkill = path.join(fixture.projectCursor, "wide-skill");
      const entryNames = Array.from(
        { length: MAX_ENTRIES_PER_ROOT + 50 },
        (_, index) => `file-${String(index).padStart(5, "0")}.txt`,
      );
      let entriesStatted = 0;

      yield* writeSkill(wideSkill, frontmatter("wide-skill", "Found before traversal stops."));
      const resolvedWideSkill = yield* fs.realPath(wideSkill);
      const instrumented = Layer.succeed(
        FileSystem.FileSystem,
        FileSystem.FileSystem.of({
          ...fs,
          readDirectory: (directory, options) =>
            String(directory) === resolvedWideSkill
              ? Effect.succeed(["SKILL.md", ...entryNames])
              : fs.readDirectory(directory, options),
          stat: (filePath) => {
            if (String(filePath).startsWith(`${resolvedWideSkill}${path.sep}`)) {
              entriesStatted += 1;
            }
            return fs.stat(filePath);
          },
        }),
      );

      const skills = yield* discoverCursorSkills(fixture.workspace, fixture.environment).pipe(
        Effect.provide(instrumented),
      );

      assert.deepEqual(
        skills.map((skill) => [skill.name, skill.description]),
        [["wide-skill", "Found before traversal stops."]],
      );
      assert.equal(entriesStatted, 0);
    }),
  );

  /**
   * A parsed-result assertion cannot tell a bounded read from a full one, so
   * this watches the requested allocation size directly.
   */
  it.effect("reads at most 64 KiB of metadata per SKILL.md", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const fixture = yield* makeFixture();
      const requestedSizes: Array<number> = [];

      yield* writeSkill(
        path.join(fixture.projectCursor, "huge"),
        `${frontmatter("huge", "Has an enormous body.")}\n${"x".repeat(512 * 1024)}`,
      );

      const instrumented = Layer.succeed(
        FileSystem.FileSystem,
        FileSystem.FileSystem.of({
          ...fs,
          open: (filePath, options) =>
            fs.open(filePath, options).pipe(
              Effect.map((file) => ({
                ...file,
                readAlloc: (size: FileSystem.SizeInput) => {
                  requestedSizes.push(Number(FileSystem.Size(size)));
                  return file.readAlloc(size);
                },
              })),
            ),
        }),
      );

      const skills = yield* discoverCursorSkills(fixture.workspace, fixture.environment).pipe(
        Effect.provide(instrumented),
      );

      assert.deepEqual(
        skills.map((skill) => [skill.name, skill.description]),
        [["huge", "Has an enormous body."]],
      );
      assert.deepEqual(requestedSizes, [64 * 1024]);
    }),
  );
});

describe("resolveCursorHomeDirectory", () => {
  it("prefers a non-empty merged HOME on POSIX", () => {
    expect(resolveCursorHomeDirectory({ HOME: "/merged/home" }, "darwin")).toBe("/merged/home");
  });

  it("prefers USERPROFILE over HOMEDRIVE and HOMEPATH on Windows", () => {
    expect(
      resolveCursorHomeDirectory(
        { USERPROFILE: "C:\\Users\\merged", HOMEDRIVE: "D:", HOMEPATH: "\\Users\\other" },
        "win32",
      ),
    ).toBe("C:\\Users\\merged");
  });

  it("falls back to a complete HOMEDRIVE and HOMEPATH pair on Windows", () => {
    expect(
      resolveCursorHomeDirectory({ HOMEDRIVE: "D:", HOMEPATH: "\\Users\\merged" }, "win32"),
    ).toBe("D:\\Users\\merged");
  });

  it("ignores blank values and an incomplete Windows pair", () => {
    expect(resolveCursorHomeDirectory({ HOME: "   " }, "linux")).toBe(NodeOS.homedir());
    expect(resolveCursorHomeDirectory({ HOMEDRIVE: "D:" }, "win32")).toBe(NodeOS.homedir());
  });

  it("does not read the POSIX home from Windows variables", () => {
    expect(resolveCursorHomeDirectory({ USERPROFILE: "C:\\Users\\merged" }, "linux")).toBe(
      NodeOS.homedir(),
    );
  });
});
