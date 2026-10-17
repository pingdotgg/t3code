import * as NodeOS from "node:os";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";

import {
  discoverCursorSkills,
  hasCursorSkillMention,
  probeCursorSkills,
  rewriteCursorSkillMentions,
} from "./skills.ts";

const runNode = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>,
) => effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.runPromise);

describe("Cursor skills", () => {
  it("discovers recursive project skills with project precedence", async () =>
    await runNode(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const userHome = yield* fileSystem
          .makeTempDirectoryScoped({
            directory: NodeOS.tmpdir(),
            prefix: "cursor-skills-home-",
          })
          .pipe(Effect.flatMap((directory) => fileSystem.realPath(directory)));
        const workspace = yield* fileSystem
          .makeTempDirectoryScoped({
            directory: NodeOS.tmpdir(),
            prefix: "cursor-skills-workspace-",
          })
          .pipe(Effect.flatMap((directory) => fileSystem.realPath(directory)));
        const writeSkill = Effect.fn("writeCursorSkill")(function* (
          root: string,
          name: string,
          contents: string,
        ) {
          const skillDirectory = path.join(root, name);
          yield* fileSystem.makeDirectory(skillDirectory, { recursive: true });
          yield* fileSystem.writeFileString(path.join(skillDirectory, "SKILL.md"), contents);
        });

        yield* writeSkill(
          path.join(userHome, ".cursor", "skills"),
          "review",
          "---\ndescription: user review\n---\n",
        );
        yield* writeSkill(
          path.join(workspace, ".agents", "skills", "nested"),
          "review",
          "---\nname: Review changes\ndescription: project review\n---\n",
        );
        yield* writeSkill(
          path.join(workspace, ".cursor", "skills"),
          "internal",
          "---\nuser-invocable: false\n---\n",
        );
        yield* writeSkill(
          path.join(workspace, ".cursor", "skills"),
          "oversized",
          "x".repeat(1_000_001),
        );
        yield* fileSystem.makeDirectory(path.join(userHome, ".codex"), { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(userHome, ".codex", "skills"),
          "not a directory",
        );

        const skills = yield* discoverCursorSkills(workspace, { HOME: userHome });
        expect(skills).toEqual([
          {
            name: "internal",
            path: path.join(workspace, ".cursor", "skills", "internal", "SKILL.md"),
            scope: "project",
            enabled: true,
            userInvocable: false,
          },
          {
            name: "oversized",
            path: path.join(workspace, ".cursor", "skills", "oversized", "SKILL.md"),
            scope: "project",
            enabled: true,
          },
          {
            name: "review",
            displayName: "Review changes",
            description: "project review",
            path: path.join(workspace, ".agents", "skills", "nested", "review", "SKILL.md"),
            scope: "project",
            enabled: true,
          },
        ]);
        expect(
          (yield* probeCursorSkills(workspace, { HOME: userHome }).pipe(Effect.result))._tag,
        ).toBe("Failure");
      }),
    ));

  it("discovers skills from installed Cursor plugins", async () =>
    await runNode(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDirectory = (prefix: string) =>
          fileSystem
            .makeTempDirectoryScoped({ directory: NodeOS.tmpdir(), prefix })
            .pipe(Effect.flatMap((directory) => fileSystem.realPath(directory)));
        const userHome = yield* tempDirectory("cursor-skills-home-");
        const workspace = yield* tempDirectory("cursor-skills-workspace-");
        const writeFile = Effect.fn("writeCursorPluginFile")(function* (
          file: string,
          contents: string,
        ) {
          yield* fileSystem.makeDirectory(path.dirname(file), { recursive: true });
          yield* fileSystem.writeFileString(file, contents);
        });
        const plugins = path.join(userHome, ".cursor", "plugins");
        const marketplace = path.join(plugins, "cache", "cursor-public");
        const designKit = path.join(marketplace, "design-kit", "4f2a9c1");
        const toolkit = path.join(marketplace, "toolkit", "9c1e7b3");
        const nameless = path.join(marketplace, "nameless", "2e8f4a1");
        const teamPlugin = path.join(plugins, "local", "team-plugin");

        yield* writeFile(
          path.join(userHome, ".agents", "skills", "deploy", "SKILL.md"),
          "---\ndescription: local deploy\n---\n",
        );
        yield* writeFile(path.join(designKit, ".cache-complete"), "");
        yield* writeFile(
          path.join(designKit, ".cursor-plugin", "plugin.json"),
          JSON.stringify({ name: "design-kit", skills: "./skills-custom/" }),
        );
        yield* writeFile(path.join(designKit, "skills-custom", "SKILL.md"), "---\n---\n");
        yield* writeFile(
          path.join(designKit, "skills-custom", "mockup", "SKILL.md"),
          "---\nname: Mockup screens\n---\n",
        );
        yield* writeFile(
          path.join(designKit, "skills-custom", "group", "nested", "SKILL.md"),
          "---\n---\n",
        );
        yield* writeFile(path.join(designKit, "skills", "decoy", "SKILL.md"), "---\n---\n");
        yield* writeFile(
          path.join(marketplace, "partial", "7b3d5e8", "skills", "half-installed", "SKILL.md"),
          "---\n---\n",
        );
        yield* writeFile(path.join(toolkit, ".cache-complete"), "");
        yield* writeFile(
          path.join(toolkit, ".cursor-plugin", "plugin.json"),
          JSON.stringify({ name: "toolkit" }),
        );
        yield* writeFile(
          path.join(toolkit, "skills", "release", "SKILL.md"),
          "---\ndescription: cut a release\ndisable-model-invocation: true\n---\n",
        );
        yield* writeFile(
          path.join(toolkit, "skills", "deploy", "SKILL.md"),
          "---\ndescription: plugin deploy\n---\n",
        );
        yield* writeFile(path.join(nameless, ".cache-complete"), "");
        yield* writeFile(
          path.join(nameless, ".cursor-plugin", "plugin.json"),
          JSON.stringify({ skills: "./custom/" }),
        );
        yield* writeFile(path.join(nameless, "custom", "unread", "SKILL.md"), "---\n---\n");
        yield* writeFile(path.join(nameless, "skills", "fallback", "SKILL.md"), "---\n---\n");
        yield* writeFile(
          path.join(teamPlugin, ".claude-plugin", "plugin.json"),
          JSON.stringify({
            name: "team-plugin",
            skills: ["./extras/lint", "extras/format/SKILL.md", "bundles", "../../shared"],
          }),
        );
        yield* writeFile(path.join(teamPlugin, "extras", "lint", "SKILL.md"), "---\n---\n");
        yield* writeFile(
          path.join(teamPlugin, "extras", "lint", "autofix", "SKILL.md"),
          "---\n---\n",
        );
        yield* writeFile(path.join(teamPlugin, "extras", "format", "SKILL.md"), "---\n---\n");
        yield* writeFile(path.join(teamPlugin, "bundles", "stylecheck", "SKILL.md"), "---\n---\n");
        yield* writeFile(path.join(plugins, "shared", "leaked", "SKILL.md"), "---\n---\n");

        const expected = [
          {
            name: "deploy",
            description: "local deploy",
            path: path.join(userHome, ".agents", "skills", "deploy", "SKILL.md"),
            scope: "user",
            enabled: true,
          },
          {
            name: "fallback",
            path: path.join(nameless, "skills", "fallback", "SKILL.md"),
            scope: "user",
            enabled: true,
          },
          {
            name: "format",
            path: path.join(teamPlugin, "extras", "format", "SKILL.md"),
            scope: "user",
            enabled: true,
          },
          {
            name: "lint",
            path: path.join(teamPlugin, "extras", "lint", "SKILL.md"),
            scope: "user",
            enabled: true,
          },
          {
            name: "mockup",
            displayName: "Mockup screens",
            path: path.join(designKit, "skills-custom", "mockup", "SKILL.md"),
            scope: "user",
            enabled: true,
          },
          {
            name: "release",
            description: "cut a release",
            path: path.join(toolkit, "skills", "release", "SKILL.md"),
            scope: "user",
            enabled: true,
            userInvocationOnly: true,
          },
          {
            name: "stylecheck",
            path: path.join(teamPlugin, "bundles", "stylecheck", "SKILL.md"),
            scope: "user",
            enabled: true,
          },
        ];
        expect(yield* discoverCursorSkills(workspace, { HOME: userHome })).toEqual(expected);
        expect(yield* probeCursorSkills(workspace, { HOME: userHome })).toEqual(expected);
      }),
    ));

  it.skipIf(!symlinksSupported)(
    "skips plugin symlinks that loop or leave the plugin without failing discovery",
    async () =>
      await runNode(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const userHome = yield* fileSystem
            .makeTempDirectoryScoped({ directory: NodeOS.tmpdir(), prefix: "cursor-skills-home-" })
            .pipe(Effect.flatMap((directory) => fileSystem.realPath(directory)));
          const writeSkill = Effect.fn("writeCursorSkill")(function* (directory: string) {
            yield* fileSystem.makeDirectory(directory, { recursive: true });
            yield* fileSystem.writeFileString(path.join(directory, "SKILL.md"), "---\n---\n");
          });
          const marketplace = path.join(userHome, ".cursor", "plugins", "cache", "cursor-public");
          const plugin = path.join(marketplace, "linked", "5d1c8e2");
          const pluginSkills = path.join(plugin, "skills");
          const outside = path.join(userHome, "elsewhere", "escaped");
          const linkedManifest = path.join(marketplace, "manifest", "1b4c7e9");
          const outsideManifest = path.join(userHome, "elsewhere", "plugin.json");

          yield* writeSkill(path.join(userHome, ".cursor", "skills", "review"));
          yield* writeSkill(path.join(pluginSkills, "release"));
          yield* fileSystem.writeFileString(path.join(plugin, ".cache-complete"), "");
          yield* writeSkill(outside);
          yield* fileSystem.symlink("loop", path.join(pluginSkills, "loop"));
          yield* fileSystem.symlink(outside, path.join(pluginSkills, "escaped"));
          yield* fileSystem.makeDirectory(path.join(pluginSkills, "linked-file"));
          yield* fileSystem.symlink(
            path.join(outside, "SKILL.md"),
            path.join(pluginSkills, "linked-file", "SKILL.md"),
          );
          yield* fileSystem.makeDirectory(path.join(pluginSkills, "shared"));
          yield* fileSystem.symlink(
            path.join(pluginSkills, "release", "SKILL.md"),
            path.join(pluginSkills, "shared", "SKILL.md"),
          );
          yield* writeSkill(path.join(linkedManifest, "custom", "from-manifest"));
          yield* writeSkill(path.join(linkedManifest, "skills", "from-default"));
          yield* fileSystem.writeFileString(path.join(linkedManifest, ".cache-complete"), "");
          yield* fileSystem.writeFileString(
            outsideManifest,
            JSON.stringify({ name: "manifest", skills: "./custom/" }),
          );
          yield* fileSystem.makeDirectory(path.join(linkedManifest, ".cursor-plugin"));
          yield* fileSystem.symlink(
            outsideManifest,
            path.join(linkedManifest, ".cursor-plugin", "plugin.json"),
          );

          expect(yield* probeCursorSkills(undefined, { HOME: userHome })).toEqual([
            {
              name: "from-default",
              path: path.join(linkedManifest, "skills", "from-default", "SKILL.md"),
              scope: "user",
              enabled: true,
            },
            {
              name: "release",
              path: path.join(pluginSkills, "release", "SKILL.md"),
              scope: "user",
              enabled: true,
            },
            {
              name: "review",
              path: path.join(userHome, ".cursor", "skills", "review", "SKILL.md"),
              scope: "user",
              enabled: true,
            },
            {
              name: "shared",
              path: path.join(pluginSkills, "shared", "SKILL.md"),
              scope: "user",
              enabled: true,
            },
          ]);
        }),
      ),
  );

  it("stops the plugin scan at the scan limits without failing discovery", async () =>
    await runNode(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const userHome = yield* fileSystem
          .makeTempDirectoryScoped({ directory: NodeOS.tmpdir(), prefix: "cursor-skills-home-" })
          .pipe(Effect.flatMap((directory) => fileSystem.realPath(directory)));
        const writeSkill = Effect.fn("writeCursorSkill")(function* (directory: string) {
          yield* fileSystem.makeDirectory(directory, { recursive: true });
          yield* fileSystem.writeFileString(path.join(directory, "SKILL.md"), "---\n---\n");
        });
        const marketplace = path.join(userHome, ".cursor", "plugins", "cache", "cursor-public");
        const crowded = path.join(marketplace, "crowded", "3a7f1c9");
        const later = path.join(marketplace, "later", "8e2b6d4");

        yield* writeSkill(path.join(userHome, ".cursor", "skills", "review"));
        yield* fileSystem.makeDirectory(path.join(crowded, ".cursor-plugin"), { recursive: true });
        yield* fileSystem.writeFileString(path.join(crowded, ".cache-complete"), "");
        yield* fileSystem.writeFileString(
          path.join(crowded, ".cursor-plugin", "plugin.json"),
          JSON.stringify({
            name: "crowded",
            description: "x".repeat(1_000_000),
            skills: "./custom/",
          }),
        );
        yield* writeSkill(path.join(crowded, "custom", "oversized-manifest"));
        yield* writeSkill(path.join(crowded, "skills", "a-first"));
        yield* Effect.forEach(
          Array.from({ length: 10_000 }, (_, index) =>
            path.join(crowded, "skills", `entry-${index}`),
          ),
          (file) => fileSystem.writeFileString(file, ""),
          { concurrency: 64, discard: true },
        );
        yield* writeSkill(path.join(later, "skills", "after-limit"));
        yield* fileSystem.writeFileString(path.join(later, ".cache-complete"), "");

        expect(yield* probeCursorSkills(undefined, { HOME: userHome })).toEqual([
          {
            name: "a-first",
            path: path.join(crowded, "skills", "a-first", "SKILL.md"),
            scope: "user",
            enabled: true,
          },
          {
            name: "review",
            path: path.join(userHome, ".cursor", "skills", "review", "SKILL.md"),
            scope: "user",
            enabled: true,
          },
        ]);
      }),
    ));

  it("skips a skill tree deeper than the limit instead of failing discovery", async () =>
    await runNode(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDirectory = (prefix: string) =>
          fileSystem
            .makeTempDirectoryScoped({ directory: NodeOS.tmpdir(), prefix })
            .pipe(Effect.flatMap((directory) => fileSystem.realPath(directory)));
        const userHome = yield* tempDirectory("cursor-skills-home-");
        const workspace = yield* tempDirectory("cursor-skills-workspace-");
        const writeSkill = Effect.fn("writeCursorSkill")(function* (directory: string) {
          yield* fileSystem.makeDirectory(directory, { recursive: true });
          yield* fileSystem.writeFileString(path.join(directory, "SKILL.md"), "---\n---\n");
        });
        const userRoot = path.join(userHome, ".claude", "skills");
        const atLimit = path.join(
          userRoot,
          "deep",
          "2",
          "3",
          "4",
          "5",
          "6",
          "7",
          "8",
          "9",
          "deep-skill",
        );

        yield* writeSkill(path.join(workspace, ".agents", "skills", "review"));
        yield* writeSkill(atLimit);
        yield* writeSkill(path.join(atLimit, "below"));
        yield* writeSkill(path.join(userRoot, "later"));

        const expected = [
          {
            name: "deep-skill",
            path: path.join(atLimit, "SKILL.md"),
            scope: "user",
            enabled: true,
          },
          {
            name: "later",
            path: path.join(userRoot, "later", "SKILL.md"),
            scope: "user",
            enabled: true,
          },
          {
            name: "review",
            path: path.join(workspace, ".agents", "skills", "review", "SKILL.md"),
            scope: "project",
            enabled: true,
          },
        ];
        expect(yield* discoverCursorSkills(workspace, { HOME: userHome })).toEqual(expected);
        expect(yield* probeCursorSkills(workspace, { HOME: userHome })).toEqual(expected);
      }),
    ));

  it("still fails discovery when a root holds more entries than the scan allows", async () =>
    await runNode(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const userHome = yield* fileSystem.makeTempDirectoryScoped({
          directory: NodeOS.tmpdir(),
          prefix: "cursor-skills-home-",
        });
        const root = path.join(userHome, ".cursor", "skills");
        yield* fileSystem.makeDirectory(root, { recursive: true });
        yield* Effect.forEach(
          Array.from({ length: 10_001 }, (_, index) => path.join(root, `entry-${index}`)),
          (file) => fileSystem.writeFileString(file, ""),
          { concurrency: 64, discard: true },
        );

        const error = yield* Effect.flip(probeCursorSkills(undefined, { HOME: userHome }));
        expect(error.message).toContain("scan-budget-exhausted");
      }),
    ));

  it.skipIf(!symlinksSupported)(
    "treats a symlinked skill outside the root as a package boundary",
    async () =>
      await runNode(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const userHome = yield* fileSystem.makeTempDirectoryScoped({
            directory: NodeOS.tmpdir(),
            prefix: "cursor-skills-home-",
          });
          const workspace = yield* fileSystem
            .makeTempDirectoryScoped({
              directory: NodeOS.tmpdir(),
              prefix: "cursor-skills-workspace-",
            })
            .pipe(Effect.flatMap((directory) => fileSystem.realPath(directory)));
          const library = yield* fileSystem.makeTempDirectoryScoped({
            directory: NodeOS.tmpdir(),
            prefix: "cursor-skills-library-",
          });
          const writeSkill = Effect.fn("writeCursorSkill")(function* (
            directory: string,
            contents: string,
          ) {
            yield* fileSystem.makeDirectory(directory, { recursive: true });
            yield* fileSystem.writeFileString(path.join(directory, "SKILL.md"), contents);
          });

          yield* writeSkill(path.join(library, "shared-review"), "---\ndescription: shared\n---\n");
          yield* writeSkill(path.join(library, "shared-review", "hidden"), "---\n---\n");
          const root = path.join(workspace, ".cursor", "skills");
          yield* fileSystem.makeDirectory(root, { recursive: true });
          yield* fileSystem.symlink(path.join(library, "shared-review"), path.join(root, "review"));

          const skills = yield* discoverCursorSkills(workspace, { HOME: userHome });
          expect(skills).toEqual([
            {
              name: "review",
              description: "shared",
              path: path.join(root, "review", "SKILL.md"),
              scope: "project",
              enabled: true,
            },
          ]);
          expect(
            (yield* probeCursorSkills(workspace, { HOME: userHome }).pipe(Effect.result))._tag,
          ).toBe("Success");
        }),
      ),
  );

  it("rewrites only discovered skill mentions into Cursor slash invocations", () => {
    expect(hasCursorSkillMention("use $Review_Pr:V2 here")).toBe(true);
    expect(hasCursorSkillMention("please $review this")).toBe(true);
    expect(
      rewriteCursorSkillMentions("use $review, keep $HOME and 5$review", new Set(["review"])),
    ).toBe("use $review, keep $HOME and 5$review");
    expect(rewriteCursorSkillMentions("please $review this", new Set(["review"]))).toBe(
      "please /review this",
    );
  });
  it("detects and invokes digit-leading Cursor skills without rewriting money", () => {
    const names = new Set(["2spec", "20k", "100M", "1e6"]);
    expect(hasCursorSkillMention("use $2spec here")).toBe(true);
    expect(hasCursorSkillMention("use $2spec here")).toBe(true);
    expect(rewriteCursorSkillMentions("use $2spec here", names)).toBe("use /2spec here");
    expect(rewriteCursorSkillMentions("use $2spec here", new Set())).toBe("use $2spec here");
    for (const text of [
      "pay $20 tomorrow",
      "budget $20k here",
      "cost $100M total",
      "limit $1e6 here",
    ]) {
      expect(hasCursorSkillMention(text)).toBe(false);
      expect(rewriteCursorSkillMentions(text, names)).toBe(text);
    }
  });
});
