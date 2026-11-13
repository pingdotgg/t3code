import * as NodeOS from "node:os";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import type * as Scope from "effect/Scope";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";

import { cursorEnabledPluginsFromResponse } from "./enabledPlugins.ts";
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
  it("discovers project, user, then built-in skills by precedence", async () =>
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
        const builtinRoot = path.join(userHome, ".cursor", "skills-cursor");
        yield* writeSkill(builtinRoot, "loop", "---\ndescription: builtin loop\n---\n");
        yield* writeSkill(builtinRoot, "review", "---\ndescription: builtin review\n---\n");
        yield* writeSkill(builtinRoot, "ide-only", "---\nmetadata:\n  surfaces:\n    - ide\n---\n");
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
            name: "loop",
            description: "builtin loop",
            path: path.join(builtinRoot, "loop", "SKILL.md"),
            scope: "system",
            enabled: true,
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

  it("discovers skills shipped by a user-local Cursor plugin", async () =>
    await runNode(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const userHome = yield* fileSystem
          .makeTempDirectoryScoped({ directory: NodeOS.tmpdir(), prefix: "cursor-plugin-home-" })
          .pipe(Effect.flatMap((directory) => fileSystem.realPath(directory)));
        const pluginRoot = path.join(userHome, ".cursor", "plugins", "local", "acme");
        yield* fileSystem.makeDirectory(path.join(pluginRoot, ".cursor-plugin"), {
          recursive: true,
        });
        yield* fileSystem.writeFileString(
          path.join(pluginRoot, ".cursor-plugin", "plugin.json"),
          JSON.stringify({ name: "acme" }),
        );
        const skillDirectory = path.join(pluginRoot, "skills", "acme-deploy");
        yield* fileSystem.makeDirectory(skillDirectory, { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(skillDirectory, "SKILL.md"),
          "---\ndescription: plugin deploy\n---\n",
        );

        const writeCachedSkill = Effect.fn("writeCachedCursorPluginSkill")(function* (
          marketplace: string,
          plugin: string,
          skill: string,
          manifest: object,
        ) {
          const root = path.join(
            userHome,
            ".cursor",
            "plugins",
            "cache",
            marketplace,
            plugin,
            "sha",
          );
          yield* fileSystem.makeDirectory(path.join(root, ".cursor-plugin"), { recursive: true });
          yield* fileSystem.writeFileString(path.join(root, ".cache-complete"), "");
          yield* fileSystem.writeFileString(
            path.join(root, ".cursor-plugin", "plugin.json"),
            JSON.stringify(manifest),
          );
          yield* fileSystem.makeDirectory(path.join(root, skill), { recursive: true });
          yield* fileSystem.writeFileString(path.join(root, skill, "SKILL.md"), "Do the thing.\n");
        });
        yield* writeCachedSkill("cursor-public", "demo", "skills/review", { name: "demo" });
        yield* writeCachedSkill("acme-team", "ops", "playbooks/rollback", {
          skills: ["./playbooks/", "../../../../../skills"],
        });
        yield* writeCachedSkill("cursor-public", "turned-off", "skills/stale", {});

        const skills = yield* discoverCursorSkills(undefined, { HOME: userHome }, [
          { marketplace: "cursor-public", name: "demo" },
          { marketplace: "acme-team", name: "ops" },
        ]);
        expect(
          skills.map((skill) => [skill.name, skill.scope, skill.userInvocationOnly ?? false]),
        ).toEqual([
          ["acme-deploy", "user", false],
          ["review", "user", false],
          ["rollback", "user", true],
        ]);
        expect(
          (yield* discoverCursorSkills(undefined, { HOME: userHome })).map((skill) => skill.name),
        ).toEqual(["acme-deploy"]);
      }),
    ));

  it("reads the account's enabled plugins and their marketplaces", () => {
    expect(
      cursorEnabledPluginsFromResponse({
        plugins: [
          { isEnabled: true, plugin: { name: "demo", marketplace: { name: "cursor-public" } } },
          { isEnabled: true, plugin: { name: "ops", marketplaceId: "7" } },
          { isEnabled: false, plugin: { name: "turned-off", marketplaceId: "7" } },
          { isEnabled: true, plugin: { name: "orphan", marketplaceId: "8" } },
        ],
        marketplaces: [{ id: "7", name: "acme-team" }],
      }),
    ).toEqual([
      { marketplace: "cursor-public", name: "demo" },
      { marketplace: "acme-team", name: "ops" },
    ]);
  });

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

  it("finds sibling skills when one skill ships more files than the scan budget", async () =>
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
        const root = path.join(workspace, ".cursor", "skills");
        const artifacts = path.join(root, "a-large", "artifacts");
        yield* fileSystem.makeDirectory(artifacts, { recursive: true });
        yield* fileSystem.writeFileString(path.join(root, "a-large", "SKILL.md"), "---\n---\n");
        yield* fileSystem.makeDirectory(path.join(root, "b-small"), { recursive: true });
        yield* fileSystem.writeFileString(path.join(root, "b-small", "SKILL.md"), "---\n---\n");
        // More ordinary files than the whole-scan entry budget of 10,000.
        yield* Effect.forEach(
          Array.from({ length: 11_000 }, (_, index) => path.join(artifacts, `file-${index}.txt`)),
          (file) => fileSystem.writeFileString(file, ""),
          { concurrency: 64, discard: true },
        );

        const expected = [
          {
            name: "a-large",
            path: path.join(root, "a-large", "SKILL.md"),
            scope: "project",
            enabled: true,
          },
          {
            name: "b-small",
            path: path.join(root, "b-small", "SKILL.md"),
            scope: "project",
            enabled: true,
          },
        ];
        expect(yield* discoverCursorSkills(workspace, { HOME: userHome })).toEqual(expected);
        expect(yield* probeCursorSkills(workspace, { HOME: userHome })).toEqual(expected);
      }),
    ));

  it("stops a scan of a huge file tree instead of statting every file", async () => {
    const root = "/workspace/.cursor/skills";
    let stats = 0;
    const fileSystem = FileSystem.layerNoop({
      realPath: (path) => Effect.succeed(path),
      readDirectory: (path) =>
        path === root
          ? Effect.succeed(Array.from({ length: 200_000 }, (_, index) => `file-${index}`))
          : Effect.succeed([]),
      stat: (path) => {
        stats += 1;
        if (path === root) return Effect.succeed({ type: "Directory" } as FileSystem.File.Info);
        if (path.startsWith(`${root}/file-`)) {
          return Effect.succeed({ type: "File" } as FileSystem.File.Info);
        }
        return Effect.fail(
          PlatformError.systemError({ _tag: "NotFound", module: "FileSystem", method: "stat" }),
        );
      },
    });

    const result = await probeCursorSkills("/workspace", { HOME: "/home" }).pipe(
      Effect.result,
      Effect.provide(Layer.mergeAll(fileSystem, Path.layer)),
      Effect.runPromise,
    );

    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { reason: "scan-budget-exhausted" },
    });
    expect(stats).toBeGreaterThanOrEqual(100_000);
    expect(stats).toBeLessThanOrEqual(100_000);
  });

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
