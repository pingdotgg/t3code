import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";

import {
  discoverCursorSkills,
  hasCursorSkillMention,
  probeCursorSkills,
  rewriteCursorSkillMentions,
} from "./CursorSkills.ts";

const runNode = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>,
) => effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.runPromise);

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

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

          // A skill package managed in a config repo and installed by symlink.
          // Its own SKILL.md must be discovered under the link name, but nothing
          // below the target may be walked.
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

  it("discovers local and completed cache plugin skills without overriding folder skills", async () =>
    await runNode(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const userHome = yield* fileSystem
          .makeTempDirectoryScoped({
            directory: NodeOS.tmpdir(),
            prefix: "cursor-plugin-skills-home-",
          })
          .pipe(Effect.flatMap((directory) => fileSystem.realPath(directory)));
        const workspace = yield* fileSystem
          .makeTempDirectoryScoped({
            directory: NodeOS.tmpdir(),
            prefix: "cursor-plugin-skills-workspace-",
          })
          .pipe(Effect.flatMap((directory) => fileSystem.realPath(directory)));
        const writeSkill = Effect.fn("writeCursorPluginSkill")(function* (
          root: string,
          name: string,
          contents: string,
        ) {
          const skillDirectory = path.join(root, name);
          yield* fileSystem.makeDirectory(skillDirectory, { recursive: true });
          yield* fileSystem.writeFileString(path.join(skillDirectory, "SKILL.md"), contents);
        });
        const markComplete = Effect.fn("markCursorPluginCacheComplete")(function* (
          directory: string,
        ) {
          yield* fileSystem.makeDirectory(directory, { recursive: true });
          yield* fileSystem.writeFileString(path.join(directory, ".cache-complete"), "");
        });

        yield* writeSkill(
          path.join(workspace, ".cursor", "skills"),
          "review",
          "---\ndescription: project review\n---\n",
        );

        const localPlugin = path.join(userHome, ".cursor", "plugins", "local", "team");
        yield* writeSkill(
          path.join(localPlugin, "skills"),
          "review",
          "---\ndescription: plugin review\n---\n",
        );
        yield* writeSkill(
          path.join(localPlugin, "skills"),
          "local-only",
          "---\nname: Local only\ndescription: from local\nuser-invocable: false\n---\n",
        );
        yield* writeSkill(
          path.join(localPlugin, "skills", "local-only", "nested"),
          "hidden",
          "---\ndescription: hidden\n---\n",
        );
        yield* writeSkill(
          path.join(userHome, ".cursor", "plugins", "local", ".secret", "skills"),
          "secret",
          "---\ndescription: secret\n---\n",
        );

        const figma = path.join(
          userHome,
          ".cursor",
          "plugins",
          "cache",
          "cursor-public",
          "figma",
          "abc",
        );
        yield* markComplete(figma);
        yield* fileSystem.makeDirectory(path.join(figma, ".cursor-plugin"), { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(figma, ".cursor-plugin", "plugin.json"),
          encodeJson({ skills: "./skills/" }),
        );
        yield* writeSkill(
          path.join(figma, "skills"),
          "figma-use",
          "---\ndescription: figma\n---\n",
        );
        yield* writeSkill(
          path.join(figma, "workflow-skills"),
          "figma-workflow",
          "---\ndescription: workflow\n---\n",
        );
        yield* fileSystem.writeFileString(
          path.join(figma, "SKILL.md"),
          "---\nname: figma-root\ndescription: root should stay out\n---\n",
        );

        const fileSkill = path.join(
          userHome,
          ".cursor",
          "plugins",
          "cache",
          "cursor-public",
          "listed",
          "sha",
        );
        yield* markComplete(fileSkill);
        yield* fileSystem.makeDirectory(path.join(fileSkill, ".cursor-plugin"), {
          recursive: true,
        });
        yield* fileSystem.writeFileString(
          path.join(fileSkill, ".cursor-plugin", "plugin.json"),
          encodeJson({ skills: "./skills/named/SKILL.md" }),
        );
        yield* writeSkill(
          path.join(fileSkill, "skills"),
          "named",
          "---\ndescription: named file\n---\n",
        );
        yield* writeSkill(
          path.join(fileSkill, "skills"),
          "other",
          "---\ndescription: not listed\n---\n",
        );

        const plain = path.join(
          userHome,
          ".cursor",
          "plugins",
          "cache",
          "cursor-public",
          "plain",
          "def",
        );
        yield* markComplete(plain);
        yield* writeSkill(
          path.join(plain, "skills"),
          "plain-skill",
          "---\ndescription: plain\n---\n",
        );
        yield* fileSystem.writeFileString(
          path.join(plain, "SKILL.md"),
          "---\nname: plain-root\ndescription: root skill\n---\n",
        );

        const skills = yield* discoverCursorSkills(workspace, { HOME: userHome });
        expect(skills).toEqual([
          {
            name: "def",
            displayName: "plain-root",
            description: "root skill",
            path: path.join(plain, "SKILL.md"),
            scope: "user",
            enabled: true,
          },
          {
            name: "figma-use",
            description: "figma",
            path: path.join(figma, "skills", "figma-use", "SKILL.md"),
            scope: "user",
            enabled: true,
          },
          {
            name: "local-only",
            displayName: "Local only",
            description: "from local",
            path: path.join(localPlugin, "skills", "local-only", "SKILL.md"),
            scope: "user",
            enabled: true,
            userInvocable: false,
          },
          {
            name: "named",
            description: "named file",
            path: path.join(fileSkill, "skills", "named", "SKILL.md"),
            scope: "user",
            enabled: true,
          },
          {
            name: "plain-skill",
            description: "plain",
            path: path.join(plain, "skills", "plain-skill", "SKILL.md"),
            scope: "user",
            enabled: true,
          },
          {
            name: "review",
            description: "project review",
            path: path.join(workspace, ".cursor", "skills", "review", "SKILL.md"),
            scope: "project",
            enabled: true,
          },
        ]);
        const invocable = new Set(
          skills.filter((skill) => skill.userInvocable !== false).map((skill) => skill.name),
        );
        expect(rewriteCursorSkillMentions("use $figma-use and $local-only", invocable)).toBe(
          "use /figma-use and $local-only",
        );
        expect(
          (yield* probeCursorSkills(workspace, { HOME: userHome }).pipe(Effect.result))._tag,
        ).toBe("Success");
      }),
    ));

  it("uses one completed cache version and manifest skill directories", async () =>
    await runNode(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const userHome = yield* fileSystem
          .makeTempDirectoryScoped({
            directory: NodeOS.tmpdir(),
            prefix: "cursor-plugin-cache-home-",
          })
          .pipe(Effect.flatMap((directory) => fileSystem.realPath(directory)));
        const writeSkill = Effect.fn("writeCachedCursorPluginSkill")(function* (
          root: string,
          name: string,
        ) {
          const skillDirectory = path.join(root, name);
          yield* fileSystem.makeDirectory(skillDirectory, { recursive: true });
          yield* fileSystem.writeFileString(
            path.join(skillDirectory, "SKILL.md"),
            `---\ndescription: ${name}\n---\n`,
          );
        });
        const markComplete = Effect.fn("markCursorPluginCacheComplete")(function* (
          directory: string,
        ) {
          yield* fileSystem.makeDirectory(directory, { recursive: true });
          yield* fileSystem.writeFileString(path.join(directory, ".cache-complete"), "");
        });

        const cache = path.join(userHome, ".cursor", "plugins", "cache", "mkt");
        const oldVersion = path.join(cache, "multi", "old");
        const newVersion = path.join(cache, "multi", "new");
        yield* writeSkill(path.join(oldVersion, "skills"), "stale");
        yield* writeSkill(path.join(newVersion, "skills"), "fresh");
        yield* markComplete(oldVersion);
        yield* markComplete(newVersion);

        const onlyVersion = path.join(cache, "only", "sha");
        yield* writeSkill(path.join(onlyVersion, "skills"), "only-skill");
        yield* markComplete(onlyVersion);
        const staleIncomplete = path.join(cache, "only", "older");
        yield* writeSkill(path.join(staleIncomplete, "skills"), "ignored");

        const escapeRoot = path.join(cache, "escape", "sha");
        yield* markComplete(escapeRoot);
        yield* fileSystem.makeDirectory(path.join(escapeRoot, ".cursor-plugin"), {
          recursive: true,
        });
        yield* fileSystem.writeFileString(
          path.join(escapeRoot, ".cursor-plugin", "plugin.json"),
          encodeJson({
            skills: ["../../../../outside-secret/secret", "skills/"],
          }),
        );
        yield* writeSkill(path.join(userHome, ".cursor", "plugins", "outside-secret"), "secret");
        yield* writeSkill(path.join(escapeRoot, "skills"), "kept");

        const skills = yield* discoverCursorSkills(undefined, { HOME: userHome });
        expect(skills.map((skill) => skill.name).toSorted()).toEqual(["kept", "only-skill"]);
      }),
    ));

  it("skips an oversized plugin manifest and still reads skills/", async () =>
    await runNode(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const userHome = yield* fileSystem
          .makeTempDirectoryScoped({
            directory: NodeOS.tmpdir(),
            prefix: "cursor-plugin-manifest-home-",
          })
          .pipe(Effect.flatMap((directory) => fileSystem.realPath(directory)));
        const plugin = path.join(userHome, ".cursor", "plugins", "local", "huge");
        const skillDirectory = path.join(plugin, "skills", "kept");
        yield* fileSystem.makeDirectory(path.join(plugin, ".cursor-plugin"), { recursive: true });
        yield* fileSystem.makeDirectory(skillDirectory, { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(plugin, ".cursor-plugin", "plugin.json"),
          "x".repeat(1_000_001),
        );
        yield* fileSystem.writeFileString(
          path.join(skillDirectory, "SKILL.md"),
          "---\ndescription: kept\n---\n",
        );

        const skills = yield* discoverCursorSkills(undefined, { HOME: userHome });
        expect(skills.map((skill) => skill.name)).toEqual(["kept"]);
        expect(
          (yield* probeCursorSkills(undefined, { HOME: userHome }).pipe(Effect.result))._tag,
        ).toBe("Success");
      }),
    ));

  it.skipIf(!symlinksSupported)(
    "skips a plugin skill file that points outside the plugin",
    async () =>
      await runNode(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const userHome = yield* fileSystem
            .makeTempDirectoryScoped({
              directory: NodeOS.tmpdir(),
              prefix: "cursor-plugin-link-home-",
            })
            .pipe(Effect.flatMap((directory) => fileSystem.realPath(directory)));
          const outside = yield* fileSystem.makeTempDirectoryScoped({
            directory: NodeOS.tmpdir(),
            prefix: "cursor-plugin-link-outside-",
          });
          yield* fileSystem.writeFileString(
            path.join(outside, "SKILL.md"),
            "---\ndescription: escaped\n---\n",
          );
          const plugin = path.join(userHome, ".cursor", "plugins", "local", "team");
          const skillDirectory = path.join(plugin, "skills", "safe");
          yield* fileSystem.makeDirectory(skillDirectory, { recursive: true });
          yield* fileSystem.writeFileString(
            path.join(skillDirectory, "SKILL.md"),
            "---\ndescription: safe\n---\n",
          );
          const escapedDirectory = path.join(plugin, "skills", "escaped");
          yield* fileSystem.makeDirectory(escapedDirectory, { recursive: true });
          yield* fileSystem.symlink(
            path.join(outside, "SKILL.md"),
            path.join(escapedDirectory, "SKILL.md"),
          );
          yield* fileSystem.symlink(
            outside,
            path.join(userHome, ".cursor", "plugins", "local", "linked-out"),
          );

          const skills = yield* discoverCursorSkills(undefined, { HOME: userHome });
          expect(skills.map((skill) => skill.name)).toEqual(["safe"]);
        }),
      ),
  );

  it.skipIf(!symlinksSupported)(
    "skips a completed cache version that points outside the cache",
    async () =>
      await runNode(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const userHome = yield* fileSystem
            .makeTempDirectoryScoped({
              directory: NodeOS.tmpdir(),
              prefix: "cursor-plugin-cache-link-home-",
            })
            .pipe(Effect.flatMap((directory) => fileSystem.realPath(directory)));
          const outside = yield* fileSystem.makeTempDirectoryScoped({
            directory: NodeOS.tmpdir(),
            prefix: "cursor-plugin-cache-link-outside-",
          });
          const outsideSkill = path.join(outside, "skills", "escaped");
          yield* fileSystem.makeDirectory(outsideSkill, { recursive: true });
          yield* fileSystem.writeFileString(path.join(outside, ".cache-complete"), "");
          yield* fileSystem.writeFileString(
            path.join(outsideSkill, "SKILL.md"),
            "---\ndescription: escaped\n---\n",
          );
          const versionLink = path.join(
            userHome,
            ".cursor",
            "plugins",
            "cache",
            "mkt",
            "linked",
            "sha",
          );
          yield* fileSystem.makeDirectory(path.dirname(versionLink), { recursive: true });
          yield* fileSystem.symlink(outside, versionLink);

          const skills = yield* discoverCursorSkills(undefined, { HOME: userHome });
          expect(skills.map((skill) => skill.name)).toEqual([]);
        }),
      ),
  );

  it("discovers local plugin skills before the cache listing can exhaust the scan", async () =>
    await runNode(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const userHome = yield* fileSystem
          .makeTempDirectoryScoped({
            directory: NodeOS.tmpdir(),
            prefix: "cursor-plugin-budget-home-",
          })
          .pipe(Effect.flatMap((directory) => fileSystem.realPath(directory)));
        const skillDirectory = path.join(
          userHome,
          ".cursor",
          "plugins",
          "local",
          "team",
          "skills",
          "local-kept",
        );
        yield* fileSystem.makeDirectory(skillDirectory, { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(skillDirectory, "SKILL.md"),
          "---\ndescription: local\n---\n",
        );
        const earlySkill = path.join(
          userHome,
          ".cursor",
          "plugins",
          "cache",
          "mkt",
          "a-early",
          "sha",
          "skills",
          "cache-kept",
        );
        yield* fileSystem.makeDirectory(earlySkill, { recursive: true });
        yield* fileSystem.writeFileString(path.join(earlySkill, "..", "..", ".cache-complete"), "");
        yield* fileSystem.writeFileString(
          path.join(earlySkill, "SKILL.md"),
          "---\ndescription: cache\n---\n",
        );
        const versions = path.join(userHome, ".cursor", "plugins", "cache", "mkt", "bulk");
        yield* fileSystem.makeDirectory(versions, { recursive: true });
        yield* Effect.sync(() => {
          for (let index = 0; index < 10_000; index += 1) {
            NodeFS.mkdirSync(path.join(versions, `v${index}`));
          }
        });

        const skills = yield* discoverCursorSkills(undefined, { HOME: userHome });
        expect(skills.map((skill) => skill.name)).toEqual(["cache-kept", "local-kept"]);
        expect(
          (yield* probeCursorSkills(undefined, { HOME: userHome }).pipe(Effect.result))._tag,
        ).toBe("Failure");
      }),
    ));

  it("reads an accepted local plugin before later entries exhaust the scan", async () =>
    await runNode(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const userHome = yield* fileSystem
          .makeTempDirectoryScoped({
            directory: NodeOS.tmpdir(),
            prefix: "cursor-plugin-local-budget-home-",
          })
          .pipe(Effect.flatMap((directory) => fileSystem.realPath(directory)));
        const skillDirectory = path.join(
          userHome,
          ".cursor",
          "plugins",
          "local",
          "a-kept",
          "skills",
          "early",
        );
        yield* fileSystem.makeDirectory(skillDirectory, { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(skillDirectory, "SKILL.md"),
          "---\ndescription: early\n---\n",
        );
        const localRoot = path.join(userHome, ".cursor", "plugins", "local");
        yield* Effect.sync(() => {
          for (let index = 0; index < 10_000; index += 1) {
            NodeFS.mkdirSync(path.join(localRoot, `z${index}`));
          }
        });

        const skills = yield* discoverCursorSkills(undefined, { HOME: userHome });
        expect(skills.map((skill) => skill.name)).toEqual(["early"]);
        expect(
          (yield* probeCursorSkills(undefined, { HOME: userHome }).pipe(Effect.result))._tag,
        ).toBe("Failure");
      }),
    ));
});
