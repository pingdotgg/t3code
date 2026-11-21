// @effect-diagnostics-next-line nodeBuiltinImport:off -- FileSystem has no lstat.
import * as NodeFSP from "node:fs/promises";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";

import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import { discoverAntigravitySkills } from "../provider/Drivers/AntigravitySkills.ts";
import { prepareAntigravityProfile } from "../provider/antigravityAuthSupport.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ServerConfig from "../config.ts";
import * as SkillsLibrary from "./SkillsLibrary.ts";

const setup = Effect.fn("SkillsLibrary.test.setup")(function* (
  drivers: ReadonlyArray<ProviderDriverKind> = [],
  configuredRoot?: { readonly directory: string; readonly enabled: boolean },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-skills-library-" });
  const claude = path.join(home, ".claude", "skills");
  const codex = path.join(home, ".codex", "skills");
  const library = path.join(home, ".agents", "skills");
  yield* fs.makeDirectory(claude, { recursive: true });
  yield* fs.makeDirectory(codex, { recursive: true });
  const reopen = (root: typeof configuredRoot, stateHome = path.join(home, "environment")) =>
    SkillsLibrary.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          ServerSettings.ServerSettingsService.layerTest(),
          ServerConfig.layerTest(home, stateHome),
          Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
            listInstances: Effect.succeed(
              drivers.map((driverKind) => ({
                instanceId: ProviderInstanceId.make(driverKind),
                driverKind,
                enabled: root?.enabled ?? true,
                ...(root ? { sharedSkillsDirectory: root.directory } : {}),
                displayName: undefined,
                continuationIdentity: { driverKind, continuationKey: driverKind },
                get orchestrationAdapter(): never {
                  throw new Error("Sharing skills must not start a provider session.");
                },
                get snapshot(): never {
                  throw new Error("Sharing skills must not probe a provider.");
                },
                get textGeneration(): never {
                  throw new Error("Sharing skills must not generate text.");
                },
              })),
            ),
          }),
        ),
      ),
      Effect.provideService(HostProcess.HomeDirectory, home),
      Effect.provideService(HostProcess.Environment, { HOME: home }),
    );
  const service = yield* reopen(configuredRoot);
  const skill = (root: string, name: string, body: string, frontmatterName = name) =>
    fs
      .makeDirectory(path.join(root, name), { recursive: true })
      .pipe(
        Effect.andThen(
          fs.writeFileString(
            path.join(root, name, "SKILL.md"),
            `---\nname: ${frontmatterName}\ndescription: test\n---\n${body}\n`,
          ),
        ),
      );
  const read = (root: string, name: string) => fs.readFileString(path.join(root, name, "SKILL.md"));
  const link = (root: string, name: string) =>
    fs.readLink(path.join(root, name)).pipe(Effect.orElseSucceed(() => undefined));
  return { fs, path, home, claude, codex, library, service, reopen, skill, read, link };
});

/** Every entry under `root`, links not followed, with what a write would change. */
const snapshot = (root: string) =>
  Effect.promise(async () => {
    const entries: Array<string> = [];
    const walk = async (directory: string) => {
      for (const name of (await NodeFSP.readdir(directory)).sort()) {
        const entry = `${directory}/${name}`;
        const info = await NodeFSP.lstat(entry);
        entries.push(`${entry} ${info.ino} ${info.mtimeMs}`);
        if (info.isDirectory()) await walk(entry);
      }
    };
    await walk(root);
    return entries;
  });

it.layer(NodeServices.layer)("SkillsLibrary", (it) => {
  describe("apply", () => {
    it.effect.skipIf(!symlinksSupported)(
      "shares a configured profile root once and restores it when disabled",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const customHome = yield* fs.makeTempDirectoryScoped({ prefix: "t3-custom-skills-" });
          const directory = path.join(customHome, "skills");
          const { service, claude, library, skill, read, link } = yield* setup(
            [ProviderDriverKind.make("claudeAgent")],
            { directory, enabled: true },
          );
          yield* skill(directory, "custom", "custom instructions");
          yield* skill(claude, "personal", "personal instructions");
          yield* skill(library, "personal", "personal instructions");
          yield* fs.symlink(path.join(claude, "personal"), path.join(directory, "personal"));
          yield* skill(library, "shared", "shared instructions");
          yield* service.apply;
          yield* service.apply;
          expect(yield* read(library, "custom")).toContain("custom instructions");
          expect(yield* read(directory, "shared")).toContain("shared instructions");
          expect(yield* link(directory, "custom")).toBe(path.join(library, "custom"));
          expect(yield* read(library, "personal")).toContain("personal instructions");
          expect(yield* read(directory, "personal")).toContain("personal instructions");
          expect((yield* service.status).conflicts).toEqual([]);
          yield* service.detach;
          expect(yield* link(directory, "custom")).toBeUndefined();
          expect(yield* read(directory, "shared")).toContain("shared instructions");
          expect(yield* read(directory, "personal")).toContain("personal instructions");
          yield* service.detach;
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "deduplicates a configured alias of the default profile",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const customHome = yield* fs.makeTempDirectoryScoped({ prefix: "t3-alias-skills-" });
          const directory = path.join(customHome, "skills");
          const { service, library, claude, skill, read } = yield* setup(
            [ProviderDriverKind.make("claudeAgent")],
            { directory, enabled: true },
          );
          yield* fs.symlink(claude, directory);
          yield* skill(library, "shared", "shared instructions");
          yield* service.apply;
          expect(
            (yield* service.status).linked.filter((entry) => entry.driver === "claudeAgent"),
          ).toEqual([{ driver: "claudeAgent", name: "shared" }]);
          yield* service.detach;
          expect(yield* read(directory, "shared")).toContain("shared instructions");
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "recognizes the library through an alias before its skills directory exists",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const customHome = yield* fs.makeTempDirectoryScoped({ prefix: "t3-library-alias-" });
          const alias = path.join(customHome, "agents");
          const directory = path.join(alias, "skills");
          const { service, library, claude, skill, read } = yield* setup(
            [ProviderDriverKind.make("claudeAgent")],
            { directory, enabled: true },
          );
          yield* fs.makeDirectory(path.dirname(library), { recursive: true });
          yield* fs.symlink(path.dirname(library), alias);
          yield* skill(claude, "custom", "custom instructions");
          yield* service.apply;
          expect(yield* read(library, "custom")).toContain("custom instructions");
          yield* service.detach;
          expect(yield* read(claude, "custom")).toContain("custom instructions");
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "does not mutate a disabled account's configured profile",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const customHome = yield* fs.makeTempDirectoryScoped({ prefix: "t3-disabled-skills-" });
          const directory = path.join(customHome, "skills");
          const { service, library, skill, link } = yield* setup(
            [ProviderDriverKind.make("claudeAgent")],
            { directory, enabled: false },
          );
          yield* skill(directory, "custom", "private instructions");
          yield* skill(library, "shared", "shared instructions");
          const before = yield* snapshot(customHome);
          yield* service.apply;
          yield* service.detach;
          expect(yield* snapshot(customHome)).toEqual(before);
          expect(yield* link(directory, "custom")).toBeUndefined();
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "makes shared skills available to a configured Antigravity with no global home",
      () =>
        Effect.gen(function* () {
          const { fs, path, home, library, service, skill, read } = yield* setup([
            ProviderDriverKind.make("antigravity"),
          ]);
          yield* skill(library, "review", "shared review instructions");
          const sourceSkill = path.join(library, "review");
          yield* fs.writeFileString(path.join(sourceSkill, "reference.md"), "reference");
          yield* fs.symlink("reference.md", path.join(sourceSkill, "inside.md"));
          const outside = path.join(home, "private.txt");
          yield* fs.writeFileString(outside, "private");
          yield* fs.symlink(outside, path.join(sourceSkill, "outside.md"));
          expect(yield* fs.exists(path.join(home, ".gemini"))).toBe(false);

          yield* service.apply;
          const profileDirectory = path.join(home, "private-profile");
          yield* prepareAntigravityProfile({ profileDirectory, userHome: home });

          const profileSkills = path.join(profileDirectory, "config", "skills");
          expect(yield* read(profileSkills, "review")).toContain("shared review instructions");
          const nativeRoot = yield* Effect.promise(() => NodeFSP.realpath(profileSkills));
          for (const name of ["SKILL.md", "inside.md"]) {
            const resolved = yield* Effect.promise(() =>
              NodeFSP.realpath(path.join(profileSkills, "review", name)),
            );
            expect(resolved.startsWith(`${nativeRoot}${path.sep}`)).toBe(true);
          }
          expect(
            yield* Effect.promise(() =>
              NodeFSP.realpath(path.join(profileSkills, "review", "outside.md")),
            ),
          ).toBe(yield* fs.realPath(outside));
          expect(
            (yield* discoverAntigravitySkills({
              cwd: path.join(home, "project"),
              userHome: home,
              profileDirectory,
            })).map((entry) => entry.name),
          ).toEqual(["review"]);
          expect(yield* fs.exists(path.join(home, ".gemini", "config", "mcp_config.json"))).toBe(
            false,
          );

          yield* skill(library, "review", "updated instructions");
          yield* fs.remove(path.join(sourceSkill, "reference.md"));
          yield* prepareAntigravityProfile({ profileDirectory, userHome: home });
          expect(yield* read(profileSkills, "review")).toContain("updated instructions");
          expect(yield* fs.exists(path.join(profileSkills, "review", "reference.md"))).toBe(false);

          yield* fs.remove(sourceSkill, { recursive: true });
          const failed = yield* prepareAntigravityProfile({
            profileDirectory,
            userHome: home,
          }).pipe(Effect.result);
          expect(failed._tag).toBe("Failure");
          yield* service.apply;
          yield* prepareAntigravityProfile({ profileDirectory, userHome: home });
          expect(yield* fs.exists(path.join(profileSkills, "review"))).toBe(false);

          yield* skill(library, "review", "restored instructions");
          yield* service.apply;
          yield* service.detach;
          yield* prepareAntigravityProfile({ profileDirectory, userHome: home });
          expect(yield* read(profileSkills, "review")).toContain("restored instructions");
          yield* skill(
            path.join(home, ".gemini", "config", "skills"),
            "review",
            "edited after detaching",
          );
          expect(yield* read(profileSkills, "review")).toContain("edited after detaching");
          expect(
            yield* fs.exists(path.join(profileDirectory, "t3-skill-snapshots", "config")),
          ).toBe(false);
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "keeps one copy of shared skills and links every native harness root",
      () =>
        Effect.gen(function* () {
          const { fs, path, home, claude, codex, library, service, skill, read, link } =
            yield* setup();
          yield* skill(claude, "shared", "same");
          yield* skill(codex, "shared", "same");
          yield* skill(claude, "claude-only", "claude");
          const antigravity = path.join(home, ".gemini", "antigravity-cli", "skills");
          yield* skill(antigravity, "antigravity-only", "antigravity");
          yield* skill(path.join(claude, "synced", "org_account"), "synced-skill", "synced");
          yield* skill(path.join(codex, ".system"), "bundled", "bundled");
          // A root that already is the library must not be emptied into itself.
          yield* fs.makeDirectory(path.join(home, ".gemini", "config"), { recursive: true });
          yield* fs.makeDirectory(path.dirname(library), { recursive: true });
          yield* fs.makeDirectory(library);
          yield* fs.symlink(library, path.join(home, ".gemini", "config", "skills"));

          yield* service.apply;

          expect((yield* fs.readDirectory(library)).sort()).toEqual([
            "antigravity-only",
            "claude-only",
            "shared",
          ]);
          expect(yield* read(library, "shared")).toContain("same");
          for (const root of [claude, codex, antigravity]) {
            expect(yield* link(root, "shared")).toBe(path.join(library, "shared"));
            expect(yield* link(root, "claude-only")).toBe(path.join(library, "claude-only"));
            expect(yield* link(root, "antigravity-only")).toBe(
              path.join(library, "antigravity-only"),
            );
          }
          expect(
            (yield* discoverAntigravitySkills({
              cwd: path.join(home, "project"),
              userHome: home,
              profileDirectory: path.join(home, "private-profile"),
            })).map((skill) => skill.name),
          ).toEqual(["antigravity-only", "claude-only", "shared"]);
          expect(yield* read(path.join(claude, "synced", "org_account"), "synced-skill")).toContain(
            "synced",
          );
          expect(yield* read(path.join(codex, ".system"), "bundled")).toContain("bundled");
          expect(yield* fs.readDirectory(path.join(codex, ".system"))).toEqual(["bundled"]);

          const status = yield* service.status;
          expect(status.libraryPath).toBe(library);
          expect(status.conflicts).toEqual([]);
          expect(status.linked).toEqual([
            { driver: "claudeAgent", name: "antigravity-only" },
            { driver: "claudeAgent", name: "claude-only" },
            { driver: "claudeAgent", name: "shared" },
            { driver: "codex", name: "antigravity-only" },
            { driver: "codex", name: "claude-only" },
            { driver: "codex", name: "shared" },
            { driver: "antigravity", name: "antigravity-only" },
            { driver: "antigravity", name: "claude-only" },
            { driver: "antigravity", name: "shared" },
          ]);

          const before = yield* snapshot(home);
          yield* service.apply;
          expect(yield* snapshot(home)).toEqual(before);
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "moves neither copy of a skill whose copies differ and reports both paths",
      () =>
        Effect.gen(function* () {
          const { fs, path, home, claude, codex, library, service, skill, read, link } =
            yield* setup();
          yield* skill(claude, "review", "claude version");
          yield* skill(codex, "review", "codex version");
          yield* skill(codex, "other", "other");
          // One folder on a case-insensitive disk, two on a case-sensitive one.
          yield* skill(claude, "Deploy", "same");
          yield* skill(codex, "deploy", "same");
          // Moving it would break a link that climbs out of the skill.
          yield* fs.makeDirectory(path.join(claude, "linked-out"));
          yield* fs.writeFileString(path.join(home, ".claude", "shared.md"), "shared");
          yield* fs.symlink("../../shared.md", path.join(claude, "linked-out", "SKILL.md"));
          // Codex's equal copy would be parked at a path the user already uses.
          yield* skill(claude, "dup", "same");
          yield* skill(codex, "dup", "same");
          yield* skill(codex, ".dup.t3-discard", "mine");

          yield* service.apply;

          expect(yield* read(claude, "review")).toContain("claude version");
          expect(yield* read(codex, "review")).toContain("codex version");
          expect(yield* link(claude, "review")).toBeUndefined();
          expect(yield* link(claude, "other")).toBe(path.join(library, "other"));
          for (const [root, name] of [
            [claude, "Deploy"],
            [codex, "deploy"],
            [claude, "linked-out"],
            [claude, "dup"],
            [codex, "dup"],
          ] as const) {
            expect(yield* link(root, name)).toBeUndefined();
          }
          expect(yield* read(claude, "linked-out")).toBe("shared");
          expect(yield* read(codex, ".dup.t3-discard")).toContain("mine");
          expect((yield* service.status).conflicts).toEqual([
            { name: "Deploy", paths: [path.join(claude, "Deploy"), path.join(codex, "deploy")] },
            { name: "review", paths: [path.join(claude, "review"), path.join(codex, "review")] },
            {
              name: "linked-out",
              paths: [path.join(claude, "linked-out"), path.join(claude, "linked-out", "SKILL.md")],
              reason: "outsideLink",
            },
            {
              name: "dup",
              paths: [path.join(codex, ".dup.t3-discard"), path.join(claude, "dup")],
            },
          ]);
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "reports a frontmatter name that differs from its folder",
      () =>
        Effect.gen(function* () {
          const { claude, service, skill } = yield* setup();
          yield* skill(claude, "deploy", "body", "ship-it");
          yield* skill(claude, "matching", "body");

          expect((yield* service.status).nameMismatches).toEqual([
            { name: "deploy", frontmatterName: "ship-it" },
          ]);
        }),
    );
  });

  describe("detach", () => {
    it.effect.skipIf(!symlinksSupported)(
      "does not use another environment's ownership journal at startup",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const profiles = yield* fs.makeTempDirectoryScoped({ prefix: "t3-isolated-skills-" });
          const directory = path.join(profiles, "skills");
          const { service, reopen, home, claude, library, skill, link } = yield* setup(
            [ProviderDriverKind.make("claudeAgent")],
            { directory, enabled: true },
          );
          yield* skill(library, "shared", "shared instructions");
          yield* service.apply;
          const otherEnvironment = yield* reopen(undefined, path.join(home, "other-environment"));
          yield* otherEnvironment.finishDetach;
          expect(yield* link(directory, "shared")).toBe(path.join(library, "shared"));
          expect(yield* link(claude, "shared")).toBe(path.join(library, "shared"));
          yield* (yield* reopen(undefined)).finishDetach;
          expect(yield* link(directory, "shared")).toBeUndefined();
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "restores former configured homes after reassignment and restart",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const profiles = yield* fs.makeTempDirectoryScoped({ prefix: "t3-old-skills-" });
          const directory = path.join(profiles, "old", "skills");
          const replacement = path.join(profiles, "new", "skills");
          const { service, reopen, library, skill, read, link } = yield* setup(
            [ProviderDriverKind.make("claudeAgent")],
            { directory, enabled: true },
          );
          yield* skill(library, "shared", "shared instructions");
          yield* service.apply;
          const changed = yield* reopen({ directory: replacement, enabled: true });
          yield* changed.apply;
          expect(yield* link(directory, "shared")).toBeUndefined();
          expect(yield* read(directory, "shared")).toContain("shared instructions");
          yield* skill(directory, "shared", "edited outside the library");
          expect((yield* changed.status).conflicts).toEqual([]);
          expect(yield* link(replacement, "shared")).toBe(path.join(library, "shared"));
          yield* skill(replacement, ".shared.t3-restore", "unrelated staged folder");
          const restartedWithoutProfile = yield* reopen(undefined);
          yield* restartedWithoutProfile.finishDetach;
          expect(yield* link(replacement, "shared")).toBe(path.join(library, "shared"));
          expect(yield* read(replacement, ".shared.t3-restore")).toContain(
            "unrelated staged folder",
          );
          yield* fs.remove(path.join(replacement, ".shared.t3-restore"), { recursive: true });
          yield* (yield* reopen(undefined)).finishDetach;
          expect(yield* link(replacement, "shared")).toBeUndefined();
          expect(yield* read(replacement, "shared")).toContain("shared instructions");
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "leaves a missing or reassigned former root alone during cleanup",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const profiles = yield* fs.makeTempDirectoryScoped({ prefix: "t3-missing-skills-" });
          const directory = path.join(profiles, "skills");
          const { service, reopen, library, skill } = yield* setup(
            [ProviderDriverKind.make("claudeAgent")],
            { directory, enabled: true },
          );
          yield* skill(library, "shared", "shared instructions");
          yield* service.apply;
          yield* fs.remove(directory, { recursive: true });
          yield* (yield* reopen(undefined)).detach;
          expect(yield* fs.exists(directory)).toBe(false);
          yield* service.apply;
          yield* fs.remove(directory, { recursive: true });
          yield* skill(directory, "shared", "new owner");
          const before = yield* snapshot(profiles);
          yield* (yield* reopen(undefined)).detach;
          expect(yield* snapshot(profiles)).toEqual(before);
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "restores real folders and removes only links into the library",
      () =>
        Effect.gen(function* () {
          const { fs, path, home, claude, codex, library, service, skill, read, link } =
            yield* setup();
          yield* skill(claude, "hello", "hello");
          yield* skill(claude, "kept", "kept");
          yield* skill(codex, "codex-only", "codex");
          const antigravityRoots = ["config", "antigravity-cli"].map((directory) =>
            path.join(home, ".gemini", directory, "skills"),
          );
          for (const root of antigravityRoots) yield* fs.makeDirectory(root, { recursive: true });
          yield* service.apply;
          const elsewhere = path.join(home, "dev", "skills");
          yield* skill(elsewhere, "mine", "mine");
          yield* fs.symlink(path.join(elsewhere, "mine"), path.join(claude, "mine"));
          // Points into the library under another name, so it is the user's link.
          yield* fs.symlink(path.join(library, "hello"), path.join(claude, "alias"));
          // A folder at the staging path that is not a copy of what it would restore.
          yield* skill(claude, ".kept.t3-restore", "mine");
          // A crash after unlinking, before the rename, leaves only the staged copy.
          yield* fs.remove(path.join(claude, "codex-only"));
          yield* fs.copy(
            path.join(library, "codex-only"),
            path.join(claude, ".codex-only.t3-restore"),
          );

          yield* service.detach;
          yield* service.detach;

          for (const name of ["hello", "codex-only"]) {
            for (const root of [claude, ...antigravityRoots]) {
              expect(yield* link(root, name)).toBeUndefined();
              expect(yield* read(root, name)).toBe(yield* read(library, name));
            }
          }
          expect(yield* link(claude, "mine")).toBe(path.join(elsewhere, "mine"));
          expect(yield* link(claude, "alias")).toBe(path.join(library, "hello"));
          expect(yield* link(claude, "kept")).toBe(path.join(library, "kept"));
          expect(yield* read(claude, ".kept.t3-restore")).toContain("mine");
          expect((yield* fs.readDirectory(claude)).sort()).toEqual([
            ".kept.t3-restore",
            "alias",
            "codex-only",
            "hello",
            "kept",
            "mine",
          ]);
          // Codex reads the library itself, so it gets no second copy.
          expect(yield* fs.readDirectory(codex)).toEqual([]);
          expect((yield* fs.readDirectory(library)).sort()).toEqual([
            "codex-only",
            "hello",
            "kept",
          ]);
          const status = yield* service.status;
          expect(status.linked).toEqual([{ driver: "claudeAgent", name: "kept" }]);
          expect(status.conflicts).toEqual([
            {
              name: "kept",
              paths: [path.join(claude, ".kept.t3-restore"), path.join(claude, "kept")],
            },
          ]);
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "finishes at startup a detach a restart interrupted while the switch is off",
      () =>
        Effect.gen(function* () {
          const { fs, path, home, claude, library, service, skill, read, link } = yield* setup();
          yield* skill(claude, "hello", "hello");
          yield* service.apply;
          yield* fs.remove(path.join(claude, "hello"));
          yield* fs.copy(path.join(library, "hello"), path.join(claude, ".hello.t3-restore"));

          yield* Layer.build(SkillsLibrary.layer).pipe(
            Effect.provide(
              Layer.mergeAll(
                ServerSettings.ServerSettingsService.layerTest(),
                ServerConfig.layerTest(home, path.join(home, "environment")),
                Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
                  listInstances: Effect.succeed([]),
                  subscribeChanges: PubSub.unbounded<void>().pipe(Effect.flatMap(PubSub.subscribe)),
                }),
              ),
            ),
            Effect.provideService(HostProcess.HomeDirectory, home),
            Effect.provideService(HostProcess.Environment, { HOME: home }),
          );

          expect(yield* link(claude, "hello")).toBeUndefined();
          expect(yield* read(claude, "hello")).toBe(yield* read(library, "hello"));
          expect(yield* fs.readDirectory(claude)).toEqual(["hello"]);
        }),
    );
  });
});
