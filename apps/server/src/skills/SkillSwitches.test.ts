import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  SkillBatchResult,
  SkillListResult,
  type Project,
  type SkillRef,
  type SkillScope,
  type SkillSummary,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { parse as parseToml } from "smol-toml";

import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as Settings from "../serverSettings.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as SkillCatalog from "./SkillCatalog.ts";
import * as SkillManager from "./SkillManager.ts";
import { makeCodexDouble, type CodexDouble } from "./testing/CodexDouble.ts";

const encodeResult = Schema.encodeUnknownEffect(SkillBatchResult);
const encodeList = Schema.encodeUnknownEffect(SkillListResult);
const agent = ProviderInstanceId.make;

const skillFile = (name: string) => `---\nname: ${name}\ndescription: The ${name} skill.\n---\n`;

/**
 * A made-up machine: a synced library linked into the shared folder (`alpha`, `beta`), a skill
 * that lives in Claude's own folder (`solo`), and a project with a real skill of its own.
 */
const makeMachine = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "t3code-switch-" }));
  const project = path.join(home, "repos/app");
  const write = (relative: string, contents: string) =>
    Effect.gen(function* () {
      const target = path.join(home, relative);
      yield* fs.makeDirectory(path.dirname(target), { recursive: true });
      yield* fs.writeFileString(target, contents);
    });
  const read = (relative: string) => fs.readFileString(path.join(home, relative));
  const exists = (relative: string) => fs.exists(path.join(home, relative));
  const link = (target: string, from: string) =>
    Effect.gen(function* () {
      yield* fs.makeDirectory(path.dirname(path.join(home, from)), { recursive: true });
      yield* fs.symlink(path.join(home, target), path.join(home, from));
    });
  for (const name of ["alpha", "beta"]) {
    yield* write(`library/skills/${name}/SKILL.md`, skillFile(name));
  }
  yield* link("library/skills/alpha", ".agents/skills/alpha");
  yield* write(".claude/skills/solo/SKILL.md", skillFile("solo"));
  yield* write("repos/app/.agents/skills/verify/SKILL.md", skillFile("verify"));
  yield* write("repos/app/.claude/skills/own/SKILL.md", skillFile("own"));
  return { fs, path, home, project, write, read, exists, link };
});

const makeProject = (workspaceRoot: string): Project => ({
  id: ProjectId.make("project-skill-switches"),
  title: "App",
  workspaceRoot,
  repositoryIdentity: null,
  faviconPath: null,
  projectIcon: null,
  defaultModelSelection: null,
  defaultThreadEnvMode: null,
  autoPull: false,
  scripts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  deletedAt: null,
});

/** The manager and catalog on a machine whose home is `home`; only `registered` are projects. */
const withManager = <A, E, R>(
  home: string,
  registered: readonly string[],
  options: {
    readonly codex?: CodexDouble;
    readonly env?: NodeJS.ProcessEnv;
    /** Provider instances over the defaults, such as a Codex instance with a shadow home. */
    readonly instances?: Record<
      string,
      { driver: ProviderDriverKind; enabled: boolean; config?: unknown }
    >;
  },
  use: (services: {
    readonly manager: SkillManager.SkillManager["Service"];
    readonly catalog: SkillCatalog.SkillCatalog["Service"];
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const registry = Layer.mock(ProviderRegistry.ProviderRegistry)({
      refreshInstance: () => Effect.succeed([]),
      refreshWorkspaceSnapshot: () => Effect.succeed([]),
    });
    const projects = Layer.mock(ProjectService.ProjectService)({
      getByWorkspaceRoot: (root) =>
        Effect.succeed(registered.includes(root) ? Option.some(makeProject(root)) : Option.none()),
    });
    const codex = options.codex;
    const instances = Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
      getInstance: (instanceId) =>
        Effect.succeed(
          instanceId === "codex" && codex !== undefined
            ? ({
                enabled: true,
                openSkillSettingsWriter: Effect.sync(() => {
                  codex.state.opened += 1;
                  return codex.write;
                }),
              } as never)
            : undefined,
        ),
    });
    const catalog = SkillCatalog.layer.pipe(
      Layer.provide(
        Settings.layerTest({
          providerInstances: {
            ...Object.fromEntries(
              ["cursor", "grok", "opencode", "antigravity", "pi"].map((driver) => [
                ProviderInstanceId.make(driver),
                { driver: ProviderDriverKind.make(driver), enabled: true },
              ]),
            ),
            ...options.instances,
          },
        }),
      ),
    );
    return yield* Effect.gen(function* () {
      return yield* use({
        manager: yield* SkillManager.SkillManager,
        catalog: yield* SkillCatalog.SkillCatalog,
      });
    }).pipe(
      Effect.provide(
        SkillManager.layer.pipe(
          Layer.provideMerge(catalog),
          Layer.provide(projects),
          Layer.provide(registry),
          Layer.provide(instances),
          Layer.provide(VcsProcess.layer),
        ),
      ),
    );
  }).pipe(
    Effect.provideService(HostProcess.Environment, {
      HOME: home,
      // Keep the managed folders of the agents that read one off the real machine.
      OPENCODE_TEST_MANAGED_CONFIG_DIR: `${home}/no-managed-opencode`,
      ...options.env,
    }),
    Effect.provideService(HostProcess.HomeDirectory, home),
  );

const refOf = (skills: readonly SkillSummary[], scope: SkillScope, name: string): SkillRef => {
  const skill = skills.find((item) => item.scope === scope && item.name === name);
  if (!skill) throw new Error(`No ${scope} skill ${name} in the list`);
  return { scope, name, home: skill.home };
};

const stateOf = (skills: readonly SkillSummary[], scope: SkillScope, name: string) =>
  Object.fromEntries(
    (skills.find((item) => item.scope === scope && item.name === name)?.access ?? []).map(
      (entry) => [entry.instanceId, entry.state],
    ),
  );

const fixedOf = (skills: readonly SkillSummary[], scope: SkillScope, name: string) =>
  (skills.find((item) => item.scope === scope && item.name === name)?.access ?? [])
    .filter((entry) => entry.fixed === true)
    .map((entry) => entry.instanceId)
    .toSorted();

it.layer(NodeServices.layer, { excludeTestServices: true })("agent skill switches", (it) => {
  describe("Codex", () => {
    it.effect.skipIf(!symlinksSupported)(
      "writes Codex's own setting for a skill in the shared folder, and takes it away again",
      () =>
        Effect.gen(function* () {
          const { fs, home } = yield* makeMachine;
          const codex = yield* makeCodexDouble(`${home}/.codex`);
          yield* withManager(home, [], { codex }, ({ manager, catalog }) =>
            Effect.gen(function* () {
              const { skills } = yield* catalog.list({});
              const alpha = refOf(skills, "global", "alpha");
              // Codex and OpenCode both read the shared folder the alpha link is in.
              expect(stateOf(skills, "global", "alpha")).toMatchObject({
                codex: "direct",
                opencode: "direct",
              });

              const off = yield* manager.disable({ skills: [alpha], agents: [agent("codex")] });

              expect(off.outcomes).toEqual([
                { skill: alpha, status: "changed", blocked: [], affected: [] },
              ]);
              yield* encodeResult(off);
              // Codex is given the real path of SKILL.md, not the link in the shared folder.
              expect(codex.calls).toEqual([
                { path: `${home}/library/skills/alpha/SKILL.md`, enabled: false },
              ]);
              expect(yield* fs.readFileString(codex.file)).toContain("enabled = false");
              const after = (yield* catalog.list({})).skills;
              expect(stateOf(after, "global", "alpha")).toMatchObject({
                codex: "off",
                opencode: "direct",
              });
              yield* encodeList(yield* catalog.list({}));
              // The link and the skill itself are untouched.
              expect(yield* fs.exists(`${home}/.agents/skills/alpha`)).toBe(true);

              const on = yield* manager.enable({ skills: [alpha], agents: [agent("codex")] });

              expect(on.outcomes[0]).toMatchObject({ status: "changed", blocked: [] });
              expect(codex.calls.at(-1)).toEqual({
                path: `${home}/library/skills/alpha/SKILL.md`,
                enabled: true,
              });
              expect(stateOf((yield* catalog.list({})).skills, "global", "alpha").codex).toBe(
                "direct",
              );
              // Nothing left behind in Codex's config.
              expect(
                (parseToml(yield* fs.readFileString(codex.file)) as { skills?: unknown }).skills,
              ).toBeUndefined();
            }),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "reads the setting back from the shadow home Codex runs in, not the shared home",
      () =>
        Effect.gen(function* () {
          const { fs, home } = yield* makeMachine;
          // The shared home has no config.toml, so the shadow home keeps a file of its own, and
          // that is where Codex's app-server writes.
          const shared = `${home}/shared-codex`;
          const shadow = `${home}/shadow-codex`;
          const codex = yield* makeCodexDouble(shadow);
          yield* withManager(
            home,
            [],
            {
              codex,
              instances: {
                codex: {
                  driver: ProviderDriverKind.make("codex"),
                  enabled: true,
                  config: { homePath: shared, shadowHomePath: shadow },
                },
              },
            },
            ({ manager, catalog }) =>
              Effect.gen(function* () {
                const { skills } = yield* catalog.list({});
                const alpha = refOf(skills, "global", "alpha");

                const off = yield* manager.disable({ skills: [alpha], agents: [agent("codex")] });

                expect(off.outcomes).toEqual([
                  { skill: alpha, status: "changed", blocked: [], affected: [] },
                ]);
                expect(yield* fs.readFileString(codex.file)).toContain("enabled = false");
                expect(yield* fs.exists(`${shared}/config.toml`)).toBe(false);
                expect(stateOf((yield* catalog.list({})).skills, "global", "alpha").codex).toBe(
                  "off",
                );

                const on = yield* manager.enable({ skills: [alpha], agents: [agent("codex")] });
                expect(on.outcomes[0]).toMatchObject({ status: "changed", blocked: [] });
                expect(stateOf((yield* catalog.list({})).skills, "global", "alpha").codex).toBe(
                  "direct",
                );
              }),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "starts Codex once for a whole request, and not at all when nothing needs writing",
      () =>
        Effect.gen(function* () {
          const { home, write } = yield* makeMachine;
          yield* write(".agents/skills/gamma/SKILL.md", skillFile("gamma"));
          const codex = yield* makeCodexDouble(`${home}/.codex`);
          yield* withManager(home, [], { codex }, ({ manager, catalog }) =>
            Effect.gen(function* () {
              const { skills } = yield* catalog.list({});
              const both = [refOf(skills, "global", "alpha"), refOf(skills, "global", "gamma")];

              yield* manager.disable({ skills: both, agents: [agent("codex")] });
              expect(codex.state.opened).toBe(1);
              expect(codex.calls).toHaveLength(2);

              // Already off: nothing to write, so Codex isn't asked again.
              const again = yield* manager.disable({ skills: both, agents: [agent("codex")] });
              expect(again.outcomes.map((outcome) => outcome.status)).toEqual([
                "unchanged",
                "unchanged",
              ]);
              expect(codex.state.opened).toBe(1);
              expect(codex.calls).toHaveLength(2);
            }),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "reads a config.toml as Codex writes it: real paths, ~, relative paths and names, not folders",
      () =>
        Effect.gen(function* () {
          const { home, write } = yield* makeMachine;
          for (const name of ["epsilon", "zeta", "eta", "theta"]) {
            yield* write(`.agents/skills/${name}/SKILL.md`, skillFile(name));
          }
          // Codex names a skill by the `name` in its header, not by its folder.
          yield* write(
            ".agents/skills/iota/SKILL.md",
            "---\nname: Iota Tools\ndescription: Declared name.\n---\n",
          );
          yield* write(
            ".codex/config.toml",
            [
              'model = "gpt-5"',
              "",
              // What `codex app-server` wrote for a disable of a skill reached through a link.
              "[[skills.config]]",
              `path = "${home}/library/skills/alpha/SKILL.md"`,
              "enabled = false",
              "",
              "[[skills.config]]",
              'path = "~/.agents/skills/epsilon/SKILL.md"',
              "enabled = false",
              "",
              "[[skills.config]]",
              'path = "../.agents/skills/zeta/SKILL.md"',
              "enabled = false",
              "",
              // A folder is not what Codex matches: this one switches nothing off.
              "[[skills.config]]",
              `path = "${home}/.agents/skills/eta"`,
              "enabled = false",
              "",
              "[[skills.config]]",
              'name = "theta"',
              "enabled = false",
              "",
              "[[skills.config]]",
              'name = "Iota Tools"',
              "enabled = false",
              "",
              // The folder name of a skill with another declared name isn't its name to Codex.
              "[[skills.config]]",
              'name = "iota"',
              "enabled = false",
              "",
            ].join("\n"),
          );
          yield* withManager(home, [], {}, ({ catalog }) =>
            Effect.gen(function* () {
              const { skills } = yield* catalog.list({});
              const codexStates = Object.fromEntries(
                ["alpha", "epsilon", "zeta", "eta", "theta", "iota"].map((name) => [
                  name,
                  stateOf(skills, "global", name).codex,
                ]),
              );
              expect(codexStates).toEqual({
                alpha: "off",
                epsilon: "off",
                zeta: "off",
                eta: "direct",
                theta: "off",
                iota: "off",
              });
              // The same file leaves OpenCode, which doesn't read it, alone.
              expect(stateOf(skills, "global", "alpha").opencode).toBe("direct");
            }),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "the last entry that names the skill decides, and a name entry is cleared by its name",
      () =>
        Effect.gen(function* () {
          const { home, write, fs } = yield* makeMachine;
          yield* write(
            ".codex/config.toml",
            [
              "[[skills.config]]",
              `path = "${home}/library/skills/alpha/SKILL.md"`,
              "enabled = false",
              "",
              "[[skills.config]]",
              'name = "alpha"',
              "enabled = false",
              "",
              "[[skills.config]]",
              'name = "beta"',
              "enabled = false",
              "",
              "[[skills.config]]",
              'name = "beta"',
              "enabled = true",
              "",
            ].join("\n"),
          );
          const codex = yield* makeCodexDouble(`${home}/.codex`);
          yield* withManager(home, [], { codex }, ({ manager, catalog }) =>
            Effect.gen(function* () {
              const { skills } = yield* catalog.list({});
              expect(stateOf(skills, "global", "alpha").codex).toBe("off");

              yield* manager.enable({
                skills: [refOf(skills, "global", "alpha")],
                agents: [agent("codex")],
              });

              // Codex removes an entry only by the selector it was written with: both go.
              expect(codex.calls).toEqual([
                { path: `${home}/library/skills/alpha/SKILL.md`, enabled: true },
                { name: "alpha", enabled: true },
              ]);
              expect(stateOf((yield* catalog.list({})).skills, "global", "alpha").codex).toBe(
                "direct",
              );
              expect(yield* fs.readFileString(codex.file)).not.toContain("alpha");
            }),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "reports setElsewhere when Codex says another layer still decides",
      () =>
        Effect.gen(function* () {
          const { home } = yield* makeMachine;
          const codex = yield* makeCodexDouble(`${home}/.codex`);
          // A managed policy that keeps every skill on.
          codex.state.effective = true;
          yield* withManager(home, [], { codex }, ({ manager, catalog }) =>
            Effect.gen(function* () {
              const { skills } = yield* catalog.list({});
              const alpha = refOf(skills, "global", "alpha");
              const blocked = yield* manager.disable({ skills: [alpha], agents: [agent("codex")] });
              expect(blocked.outcomes[0]).toMatchObject({
                status: "skipped",
                blocked: [{ instanceId: "codex", reason: "setElsewhere" }],
              });
              yield* encodeResult(blocked);
            }),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "reports failed, writing nothing, when there is no Codex to ask",
      () =>
        Effect.gen(function* () {
          const { home, exists } = yield* makeMachine;
          yield* withManager(home, [], {}, ({ manager, catalog }) =>
            Effect.gen(function* () {
              const { skills } = yield* catalog.list({});
              const result = yield* manager.disable({
                skills: [refOf(skills, "global", "alpha")],
                agents: [agent("codex")],
              });
              expect(result.outcomes[0]).toMatchObject({
                status: "skipped",
                blocked: [{ instanceId: "codex", reason: "failed" }],
              });
              expect(yield* exists(".codex/config.toml")).toBe(false);
            }),
          );
        }),
    );
  });

  describe("OpenCode", () => {
    const jsonc = [
      "{",
      "  // my opencode settings",
      '  "theme": "dark", // keep this one',
      "  /* permissions */",
      '  "permission": {',
      '    "bash": "ask",',
      "  },",
      "}",
      "",
    ].join("\n");

    it.effect.skipIf(!symlinksSupported)(
      "writes a deny into an existing JSONC config without touching its comments, and deletes it again",
      () =>
        Effect.gen(function* () {
          const { home, write, read } = yield* makeMachine;
          yield* write(".config/opencode/opencode.jsonc", jsonc);
          yield* withManager(home, [], {}, ({ manager, catalog }) =>
            Effect.gen(function* () {
              const { skills } = yield* catalog.list({});
              const alpha = refOf(skills, "global", "alpha");

              const off = yield* manager.disable({ skills: [alpha], agents: [agent("opencode")] });

              expect(off.outcomes[0]).toMatchObject({ status: "changed", blocked: [] });
              yield* encodeResult(off);
              const written = yield* read(".config/opencode/opencode.jsonc");
              expect(written).toContain("// my opencode settings");
              expect(written).toContain('"theme": "dark", // keep this one');
              expect(written).toContain("/* permissions */");
              expect(written).toContain('"bash": "ask"');
              expect(written).toContain('"alpha": "deny"');
              const after = (yield* catalog.list({})).skills;
              expect(stateOf(after, "global", "alpha")).toMatchObject({
                opencode: "off",
                codex: "direct",
              });

              const on = yield* manager.enable({ skills: [alpha], agents: [agent("opencode")] });

              expect(on.outcomes[0]).toMatchObject({ status: "changed", blocked: [] });
              const restored = yield* read(".config/opencode/opencode.jsonc");
              expect(restored).not.toContain("alpha");
              expect(restored).toContain("// my opencode settings");
              expect(restored).toContain("/* permissions */");
              expect(restored).toContain('"bash": "ask"');
              expect(stateOf((yield* catalog.list({})).skills, "global", "alpha").opencode).toBe(
                "direct",
              );
            }),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "creates the config when there is none, honours XDG_CONFIG_HOME, and removes what it made",
      () =>
        Effect.gen(function* () {
          const { home, exists, read } = yield* makeMachine;
          yield* withManager(
            home,
            [],
            { env: { XDG_CONFIG_HOME: `${home}/xdg` } },
            ({ manager, catalog }) =>
              Effect.gen(function* () {
                const { skills } = yield* catalog.list({});
                const alpha = refOf(skills, "global", "alpha");
                yield* manager.disable({ skills: [alpha], agents: [agent("opencode")] });

                expect(yield* exists(".config/opencode/opencode.json")).toBe(false);
                expect(JSON.parse(yield* read("xdg/opencode/opencode.json"))).toEqual({
                  permission: { skill: { alpha: "deny" } },
                });
                expect(stateOf((yield* catalog.list({})).skills, "global", "alpha").opencode).toBe(
                  "off",
                );

                yield* manager.enable({ skills: [alpha], agents: [agent("opencode")] });
                expect(JSON.parse(yield* read("xdg/opencode/opencode.json"))).toEqual({});
              }),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "names the skill the way OpenCode does: by the name in its header, not its folder",
      () =>
        Effect.gen(function* () {
          const { home, write, read } = yield* makeMachine;
          yield* write(
            ".agents/skills/kappa-folder/SKILL.md",
            "---\nname: kappa\ndescription: Declared name.\n---\n",
          );
          yield* withManager(home, [], {}, ({ manager, catalog }) =>
            Effect.gen(function* () {
              const { skills } = yield* catalog.list({});
              yield* manager.disable({
                skills: [refOf(skills, "global", "kappa-folder")],
                agents: [agent("opencode")],
              });
              expect(JSON.parse(yield* read(".config/opencode/opencode.json"))).toEqual({
                permission: { skill: { kappa: "deny" } },
              });
              expect(
                stateOf((yield* catalog.list({})).skills, "global", "kappa-folder").opencode,
              ).toBe("off");
            }),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "writes an allow after a wildcard deny, and leaves it alone when a project rule decides",
      () =>
        Effect.gen(function* () {
          const { home, project, write, read } = yield* makeMachine;
          yield* write(
            ".config/opencode/opencode.json",
            JSON.stringify({ permission: { skill: { "*": "deny", alpha: "deny" } } }),
          );
          yield* write(
            "repos/app/opencode.json",
            JSON.stringify({ permission: { skill: { beta: "deny" } } }),
          );
          yield* withManager(home, [project], {}, ({ manager, catalog }) =>
            Effect.gen(function* () {
              const { skills } = yield* catalog.list({ cwd: project });
              expect(stateOf(skills, "global", "alpha").opencode).toBe("off");

              // Deleting the key would leave `*` denying it, so it is allowed after it.
              const on = yield* manager.enable({
                cwd: project,
                skills: [refOf(skills, "global", "alpha")],
                agents: [agent("opencode")],
              });
              expect(on.outcomes[0]).toMatchObject({ status: "changed", blocked: [] });
              expect(JSON.parse(yield* read(".config/opencode/opencode.json"))).toEqual({
                permission: { skill: { "*": "deny", alpha: "allow" } },
              });
              expect(
                stateOf((yield* catalog.list({ cwd: project })).skills, "global", "alpha").opencode,
              ).toBe("direct");
            }),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "reports setElsewhere, writing nothing, when the project's own config keeps the skill off",
      () =>
        Effect.gen(function* () {
          const { home, project, write, read } = yield* makeMachine;
          yield* write(
            "repos/app/opencode.json",
            JSON.stringify({ permission: { skill: { alpha: "deny" } } }),
          );
          yield* write(".config/opencode/opencode.json", '{ "theme": "dark" }');
          yield* withManager(home, [project], {}, ({ manager, catalog }) =>
            Effect.gen(function* () {
              const { skills } = yield* catalog.list({ cwd: project });
              expect(stateOf(skills, "global", "alpha").opencode).toBe("off");

              const result = yield* manager.enable({
                cwd: project,
                skills: [refOf(skills, "global", "alpha")],
                agents: [agent("opencode")],
              });

              expect(result.outcomes[0]).toMatchObject({
                status: "skipped",
                blocked: [{ instanceId: "opencode", reason: "setElsewhere" }],
              });
              expect(yield* read(".config/opencode/opencode.json")).toBe('{ "theme": "dark" }');
            }),
          );
        }),
    );
  });

  describe("Claude Code", () => {
    it.effect.skipIf(!symlinksSupported)(
      "writes skillOverrides to the user settings for a real folder in the user's skills, keeping the file's comments and permissions",
      () =>
        Effect.gen(function* () {
          const { fs, path, home, write, read } = yield* makeMachine;
          const original =
            '{\n  // my settings\n  "model": "opus", /* keep */\n  "env": { "A": "1" }\n}\n';
          yield* write(".claude/settings.json", original);
          yield* fs.chmod(path.join(home, ".claude/settings.json"), 0o600);
          yield* withManager(home, [], {}, ({ manager, catalog }) =>
            Effect.gen(function* () {
              const { skills } = yield* catalog.list({});
              const solo = refOf(skills, "global", "solo");
              expect(stateOf(skills, "global", "solo").claudeAgent).toBe("direct");

              const off = yield* manager.disable({
                skills: [solo],
                agents: [agent("claudeAgent")],
              });

              expect(off.outcomes[0]).toMatchObject({
                status: "changed",
                blocked: [],
                affected: [],
              });
              yield* encodeResult(off);
              const written = yield* read(".claude/settings.json");
              expect(written).toContain("// my settings");
              expect(written).toContain("/* keep */");
              expect(JSON.parse(written.replace(/\/\/.*|\/\*.*?\*\//g, ""))).toMatchObject({
                model: "opus",
                skillOverrides: { solo: "off" },
              });
              expect((yield* fs.stat(path.join(home, ".claude/settings.json"))).mode & 0o777).toBe(
                0o600,
              );
              expect(yield* fs.exists(path.join(home, ".claude/skills/solo/SKILL.md"))).toBe(true);
              expect(stateOf((yield* catalog.list({})).skills, "global", "solo").claudeAgent).toBe(
                "off",
              );

              const on = yield* manager.enable({ skills: [solo], agents: [agent("claudeAgent")] });

              expect(on.outcomes[0]).toMatchObject({ status: "changed", blocked: [] });
              const restored = yield* read(".claude/settings.json");
              // Everything the user wrote is still there; only the indentation next to the key
              // that was added may differ.
              expect(restored).toContain("// my settings");
              expect(restored).toContain("/* keep */");
              expect(restored).not.toContain("skillOverrides");
              expect(JSON.parse(restored.replace(/\/\/.*|\/\*.*?\*\//g, ""))).toEqual({
                model: "opus",
                env: { A: "1" },
              });
              expect(stateOf((yield* catalog.list({})).skills, "global", "solo").claudeAgent).toBe(
                "direct",
              );
            }),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "writes a project skill to the project's settings.local.json, not the user's or the shared one",
      () =>
        Effect.gen(function* () {
          const { home, project, write, read, exists } = yield* makeMachine;
          yield* write("repos/app/.claude/settings.json", '{ "model": "opus" }');
          yield* withManager(home, [project], {}, ({ manager, catalog }) =>
            Effect.gen(function* () {
              const { skills } = yield* catalog.list({ cwd: project });
              const own = refOf(skills, "project", "own");
              expect(stateOf(skills, "project", "own").claudeAgent).toBe("direct");

              yield* manager.disable({
                cwd: project,
                skills: [own],
                agents: [agent("claudeAgent")],
              });

              expect(JSON.parse(yield* read("repos/app/.claude/settings.local.json"))).toEqual({
                skillOverrides: { own: "off" },
              });
              expect(yield* read("repos/app/.claude/settings.json")).toBe('{ "model": "opus" }');
              expect(yield* exists(".claude/settings.json")).toBe(false);
              expect(
                stateOf((yield* catalog.list({ cwd: project })).skills, "project", "own")
                  .claudeAgent,
              ).toBe("off");

              yield* manager.enable({
                cwd: project,
                skills: [own],
                agents: [agent("claudeAgent")],
              });
              expect(JSON.parse(yield* read("repos/app/.claude/settings.local.json"))).toEqual({});
              expect(
                stateOf((yield* catalog.list({ cwd: project })).skills, "project", "own")
                  .claudeAgent,
              ).toBe("direct");
            }),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "reports setElsewhere when a project setting keeps the skill on or off, writing nothing",
      () =>
        Effect.gen(function* () {
          const { home, project, write, read } = yield* makeMachine;
          // The user's file has it off; the project's local file turns it on over that.
          yield* write(".claude/settings.json", '{ "skillOverrides": { "solo": "off" } }');
          yield* write(
            "repos/app/.claude/settings.local.json",
            '{ "skillOverrides": { "solo": "on" } }',
          );
          yield* withManager(home, [project], {}, ({ manager, catalog }) =>
            Effect.gen(function* () {
              const { skills } = yield* catalog.list({ cwd: project });
              const solo = refOf(skills, "global", "solo");
              // Over there the project says on, so the user's `off` is not what decides.
              expect(stateOf(skills, "global", "solo").claudeAgent).toBe("direct");

              const off = yield* manager.disable({
                cwd: project,
                skills: [solo],
                agents: [agent("claudeAgent")],
              });
              expect(off.outcomes[0]).toMatchObject({
                status: "skipped",
                blocked: [{ instanceId: "claudeAgent", reason: "setElsewhere" }],
              });
              expect(yield* read(".claude/settings.json")).toBe(
                '{ "skillOverrides": { "solo": "off" } }',
              );
            }),
          );
          // And the other way: the project's file keeps it off while the user's would turn it on.
          yield* write(".claude/settings.json", "{}");
          yield* write(
            "repos/app/.claude/settings.local.json",
            '{ "skillOverrides": { "solo": "off" } }',
          );
          yield* withManager(home, [project], {}, ({ manager, catalog }) =>
            Effect.gen(function* () {
              const { skills } = yield* catalog.list({ cwd: project });
              expect(stateOf(skills, "global", "solo").claudeAgent).toBe("off");
              const on = yield* manager.enable({
                cwd: project,
                skills: [refOf(skills, "global", "solo")],
                agents: [agent("claudeAgent")],
              });
              expect(on.outcomes[0]).toMatchObject({
                status: "skipped",
                blocked: [{ instanceId: "claudeAgent", reason: "setElsewhere" }],
              });
              expect(yield* read(".claude/settings.json")).toBe("{}");
            }),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "reports setElsewhere when the organization's managed settings decide, in either direction",
      () =>
        Effect.gen(function* () {
          const { home, write, read, exists } = yield* makeMachine;
          // The managed file is at a fixed system path on Linux, so this runs as Windows, where it
          // is under %PROGRAMDATA%.
          const asWindows = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
            effect.pipe(Effect.provideService(HostProcess.Platform, "win32"));
          const env = { USERPROFILE: home, PROGRAMDATA: `${home}/ProgramData` };
          yield* write(
            "ProgramData/ClaudeCode/managed-settings.json",
            '{ "skillOverrides": { "solo": "off" } }',
          );
          yield* asWindows(
            withManager(home, [], { env }, ({ manager, catalog }) =>
              Effect.gen(function* () {
                const { skills } = yield* catalog.list({});
                const solo = refOf(skills, "global", "solo");
                expect(stateOf(skills, "global", "solo").claudeAgent).toBe("off");

                const on = yield* manager.enable({
                  skills: [solo],
                  agents: [agent("claudeAgent")],
                });

                expect(on.outcomes[0]).toMatchObject({
                  status: "skipped",
                  blocked: [{ instanceId: "claudeAgent", reason: "setElsewhere" }],
                });
                yield* encodeResult(on);
                expect(yield* exists(".claude/settings.json")).toBe(false);
              }),
            ),
          );
          yield* write(
            "ProgramData/ClaudeCode/managed-settings.json",
            '{ "skillOverrides": { "solo": "on" } }',
          );
          yield* asWindows(
            withManager(home, [], { env }, ({ manager, catalog }) =>
              Effect.gen(function* () {
                const { skills } = yield* catalog.list({});
                const off = yield* manager.disable({
                  skills: [refOf(skills, "global", "solo")],
                  agents: [agent("claudeAgent")],
                });
                expect(off.outcomes[0]).toMatchObject({
                  status: "skipped",
                  blocked: [{ instanceId: "claudeAgent", reason: "setElsewhere" }],
                });
                expect(yield* exists(".claude/settings.json")).toBe(false);
                expect(yield* read("ProgramData/ClaudeCode/managed-settings.json")).toBe(
                  '{ "skillOverrides": { "solo": "on" } }',
                );
              }),
            ),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "writes nothing to a settings file that doesn't parse or that Claude Code would ignore, and says failed",
      () =>
        Effect.gen(function* () {
          const { home, write, read } = yield* makeMachine;
          for (const broken of [
            '{ "skillOverrides": ',
            '{ "skillOverrides": { "other": "maybe" } }',
            "[]",
          ]) {
            yield* write(".claude/settings.json", broken);
            yield* withManager(home, [], {}, ({ manager, catalog }) =>
              Effect.gen(function* () {
                const { skills } = yield* catalog.list({});
                const result = yield* manager.disable({
                  skills: [refOf(skills, "global", "solo")],
                  agents: [agent("claudeAgent")],
                });
                expect(result.outcomes[0]).toMatchObject({
                  status: "skipped",
                  blocked: [{ instanceId: "claudeAgent", reason: "failed" }],
                });
                yield* encodeResult(result);
                expect(yield* read(".claude/settings.json")).toBe(broken);
                expect(
                  stateOf((yield* catalog.list({})).skills, "global", "solo").claudeAgent,
                ).toBe("direct");
              }),
            );
          }
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "still removes the link, and writes no settings, for a skill Claude reaches through a link",
      () =>
        Effect.gen(function* () {
          const { fs, path, home, link, exists } = yield* makeMachine;
          yield* link("library/skills/alpha", ".claude/skills/alpha");
          yield* withManager(home, [], {}, ({ manager, catalog }) =>
            Effect.gen(function* () {
              const { skills } = yield* catalog.list({});
              const alpha = refOf(skills, "global", "alpha");
              expect(stateOf(skills, "global", "alpha").claudeAgent).toBe("link");
              expect(fixedOf(skills, "global", "alpha")).not.toContain("claudeAgent");

              const off = yield* manager.disable({
                skills: [alpha],
                agents: [agent("claudeAgent")],
              });

              expect(off.outcomes[0]).toMatchObject({ status: "changed", blocked: [] });
              expect(yield* fs.exists(path.join(home, ".claude/skills/alpha"))).toBe(false);
              expect(yield* exists(".claude/settings.json")).toBe(false);

              const on = yield* manager.enable({ skills: [alpha], agents: [agent("claudeAgent")] });
              expect(on.outcomes[0]).toMatchObject({ status: "changed", blocked: [] });
              expect(yield* fs.readLink(path.join(home, ".claude/skills/alpha"))).toBe(
                path.join(home, "library/skills/alpha"),
              );
              expect(yield* exists(".claude/settings.json")).toBe(false);
            }),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "turns a skill on that was off in Claude's settings and had no link: the link and the setting both",
      () =>
        Effect.gen(function* () {
          const { fs, path, home, write, read } = yield* makeMachine;
          yield* write(".claude/settings.json", '{ "skillOverrides": { "alpha": "off" } }');
          yield* withManager(home, [], {}, ({ manager, catalog }) =>
            Effect.gen(function* () {
              const { skills } = yield* catalog.list({});
              // Claude can't see alpha at all, so the setting changes nothing it shows yet.
              expect(stateOf(skills, "global", "alpha").claudeAgent).toBe("none");

              yield* manager.enable({
                skills: [refOf(skills, "global", "alpha")],
                agents: [agent("claudeAgent")],
              });

              expect(yield* fs.readLink(path.join(home, ".claude/skills/alpha"))).toBe(
                path.join(home, "library/skills/alpha"),
              );
              expect(JSON.parse(yield* read(".claude/settings.json"))).toEqual({});
              expect(stateOf((yield* catalog.list({})).skills, "global", "alpha").claudeAgent).toBe(
                "link",
              );
            }),
          );
        }),
    );
  });

  describe("Pi", () => {
    it.effect.skipIf(!symlinksSupported)(
      "writes the exact exclusion Pi's own config writes for a Global skill, and removes it",
      () =>
        Effect.gen(function* () {
          const { home, write, read } = yield* makeMachine;
          const original = '{\n  "defaultModel": "m",\n  "skills": [\n    "extra"\n  ]\n}\n';
          yield* write(".pi/agent/settings.json", original);
          yield* withManager(home, [], {}, ({ manager, catalog }) =>
            Effect.gen(function* () {
              const { skills } = yield* catalog.list({});
              const alpha = refOf(skills, "global", "alpha");
              expect(stateOf(skills, "global", "alpha").pi).toBe("direct");
              expect(fixedOf(skills, "global", "alpha")).not.toContain("pi");

              const off = yield* manager.disable({ skills: [alpha], agents: [agent("pi")] });

              expect(off.outcomes[0]).toMatchObject({ status: "changed", blocked: [] });
              expect(JSON.parse(yield* read(".pi/agent/settings.json"))).toEqual({
                defaultModel: "m",
                skills: ["extra", "-skills/alpha/SKILL.md"],
              });
              expect(stateOf((yield* catalog.list({})).skills, "global", "alpha").pi).toBe("off");

              yield* manager.enable({ skills: [alpha], agents: [agent("pi")] });
              expect(yield* read(".pi/agent/settings.json")).toBe(original);
              expect(stateOf((yield* catalog.list({})).skills, "global", "alpha").pi).toBe(
                "direct",
              );
            }),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "leaves a settings file alone that Pi can't read, because Pi reads plain JSON",
      () =>
        Effect.gen(function* () {
          const { home, write, read } = yield* makeMachine;
          const withComment = '{\n  // mine\n  "skills": ["extra"]\n}\n';
          yield* write(".pi/agent/settings.json", withComment);
          yield* withManager(home, [], {}, ({ manager, catalog }) =>
            Effect.gen(function* () {
              const { skills } = yield* catalog.list({});
              const result = yield* manager.disable({
                skills: [refOf(skills, "global", "alpha")],
                agents: [agent("pi")],
              });
              expect(result.outcomes[0]).toMatchObject({
                status: "skipped",
                blocked: [{ instanceId: "pi", reason: "failed" }],
              });
              expect(yield* read(".pi/agent/settings.json")).toBe(withComment);
            }),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "follows PI_CODING_AGENT_DIR, and leaves a project skill fixed",
      () =>
        Effect.gen(function* () {
          const { home, project, read } = yield* makeMachine;
          yield* withManager(
            home,
            [project],
            { env: { PI_CODING_AGENT_DIR: `${home}/pi-home` } },
            ({ manager, catalog }) =>
              Effect.gen(function* () {
                const { skills } = yield* catalog.list({ cwd: project });
                yield* manager.disable({
                  cwd: project,
                  skills: [refOf(skills, "global", "alpha")],
                  agents: [agent("pi")],
                });
                expect(JSON.parse(yield* read("pi-home/settings.json"))).toEqual({
                  skills: ["-skills/alpha/SKILL.md"],
                });

                // A project's skills would be filtered in a file the project commits.
                expect(fixedOf(skills, "project", "verify")).toContain("pi");
                const refused = yield* manager.disable({
                  cwd: project,
                  skills: [refOf(skills, "project", "verify")],
                  agents: [agent("pi")],
                });
                expect(refused.outcomes[0]).toMatchObject({
                  status: "skipped",
                  blocked: [{ instanceId: "pi", reason: "alwaysOn" }],
                });
              }),
          );
        }),
    );
  });

  describe("agents without a setting", () => {
    it.effect.skipIf(!symlinksSupported)(
      "marks them fixed, and reports alwaysOn when asked to switch them off",
      () =>
        Effect.gen(function* () {
          const { home, project } = yield* makeMachine;
          yield* withManager(home, [project], {}, ({ manager, catalog }) =>
            Effect.gen(function* () {
              const listed = yield* catalog.list({ cwd: project });
              yield* encodeList(listed);
              // Cursor, Grok and Antigravity have no per-skill setting. Antigravity doesn't read
              // the shared global folder at all.
              expect(fixedOf(listed.skills, "global", "alpha")).toEqual(["cursor", "grok"]);
              expect(fixedOf(listed.skills, "project", "verify")).toEqual([
                "antigravity",
                "cursor",
                "pi",
              ]);

              const result = yield* manager.disable({
                cwd: project,
                skills: [refOf(listed.skills, "global", "alpha")],
                agents: [agent("cursor"), agent("grok"), agent("antigravity")],
              });

              expect(result.outcomes[0]).toMatchObject({
                status: "skipped",
                blocked: [
                  { instanceId: "cursor", reason: "alwaysOn" },
                  { instanceId: "grok", reason: "alwaysOn" },
                ],
              });
              yield* encodeResult(result);
            }),
          );
        }),
    );
  });
});
