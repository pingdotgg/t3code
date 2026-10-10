import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  SkillBatchResult,
  SkillDeleteInput,
  SkillDisableInput,
  SkillEnableInput,
  SkillListResult,
  SkillPlaceInput,
  SkillRequestError,
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
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";

import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as Settings from "../serverSettings.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as SkillCatalog from "./SkillCatalog.ts";
import { RegisteredProjects } from "./SkillLibrary.ts";
import * as SkillManager from "./SkillManager.ts";
import { planEnable } from "./SkillManager.ts";

const encodeResult = Schema.encodeUnknownEffect(SkillBatchResult);
const agent = ProviderInstanceId.make;
const ALL_AGENTS = ["claudeAgent", "codex", "cursor", "grok", "opencode", "antigravity", "pi"].map(
  (id) => agent(id),
);

const skillFile = (name: string) => `---\nname: ${name}\ndescription: The ${name} skill.\n---\n`;

/** A made-up machine: a synced library linked into the shared folder, and a project in a repo. */
const makeMachine = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "t3code-manager-" }));
  const project = path.join(home, "repos/app");
  const write = (relative: string, contents: string) =>
    Effect.gen(function* () {
      const target = path.join(home, relative);
      yield* fs.makeDirectory(path.dirname(target), { recursive: true });
      yield* fs.writeFileString(target, contents);
    });
  const link = (target: string, from: string) =>
    Effect.gen(function* () {
      yield* fs.makeDirectory(path.dirname(path.join(home, from)), { recursive: true });
      yield* fs.symlink(path.join(home, target), path.join(home, from));
    });
  for (const name of ["alpha", "beta"]) {
    yield* write(`library/skills/${name}/SKILL.md`, skillFile(name));
    yield* write(`library/skills/${name}/notes.md`, `notes on ${name}`);
  }
  yield* link("library/skills/alpha", ".agents/skills/alpha");
  yield* write(".claude/skills/solo/SKILL.md", skillFile("solo"));
  yield* write("repos/app/.agents/skills/verify/SKILL.md", skillFile("verify"));
  yield* write("repos/app/.agents/skills/verify/run.sh", "echo ok");
  return { fs, path, home, project, write, link };
});

const makeProject = (workspaceRoot: string): Project => ({
  id: ProjectId.make("project-skill-manager"),
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

/** A skill-list refresh the manager asked the provider registry for. */
type Refresh = {
  readonly instanceId: ProviderInstanceId;
  /** Absent when only the agent's machine-wide list was refreshed. */
  readonly cwd: string | undefined;
  readonly fresh: boolean | undefined;
};

/**
 * The manager and catalog on a machine whose home is `home`; only `registered` folders are
 * projects. The provider registry is a stand-in that queues each refresh it is asked for.
 */
const withManager = <A, E, R>(
  home: string,
  registered: readonly string[],
  use: (services: {
    readonly manager: SkillManager.SkillManager["Service"];
    readonly catalog: SkillCatalog.SkillCatalog["Service"];
    readonly refreshes: Queue.Queue<Refresh>;
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const refreshes = yield* Queue.unbounded<Refresh>();
    const registry = Layer.mock(ProviderRegistry.ProviderRegistry)({
      refreshInstance: (instanceId) =>
        Queue.offer(refreshes, { instanceId, cwd: undefined, fresh: undefined }).pipe(
          Effect.as([]),
        ),
      refreshWorkspaceSnapshot: ({ instanceId, cwd, fresh }) =>
        Queue.offer(refreshes, { instanceId, cwd, fresh }).pipe(Effect.as([])),
    });
    // No agent in these tests has a settings writer, so none of them is ever looked up.
    const instances = Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
      getInstance: () => Effect.succeed(undefined),
    });
    const projects = Layer.mock(ProjectService.ProjectService)({
      getByWorkspaceRoot: (root) =>
        Effect.succeed(registered.includes(root) ? Option.some(makeProject(root)) : Option.none()),
      listShells: () =>
        Effect.succeed(registered.map((workspaceRoot) => ({ workspaceRoot }) as never)),
    });
    const catalog = SkillCatalog.layer.pipe(
      Layer.provide(
        Settings.layerTest({
          providerInstances: Object.fromEntries(
            ["cursor", "grok", "opencode", "antigravity", "pi"].map((driver) => [
              ProviderInstanceId.make(driver),
              { driver: ProviderDriverKind.make(driver), enabled: true },
            ]),
          ),
        }),
      ),
    );
    return yield* Effect.gen(function* () {
      return yield* use({
        manager: yield* SkillManager.SkillManager,
        catalog: yield* SkillCatalog.SkillCatalog,
        refreshes,
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
    Effect.provideService(HostProcess.Environment, { HOME: home }),
    Effect.provideService(HostProcess.HomeDirectory, home),
    Effect.provideService(RegisteredProjects, Effect.succeed(registered)),
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

it.layer(NodeServices.layer, { excludeTestServices: true })("SkillManager", (it) => {
  describe("enable", () => {
    it.effect.skipIf(!symlinksSupported)(
      "gives one agent a global skill through an absolute link in its own folder",
      () =>
        Effect.gen(function* () {
          const { fs, path, home } = yield* makeMachine;
          yield* withManager(home, [], ({ manager, catalog }) =>
            Effect.gen(function* () {
              const { skills } = yield* catalog.list({});
              expect(stateOf(skills, "global", "alpha").claudeAgent).toBe("none");

              const result = yield* manager.enable({
                skills: [refOf(skills, "global", "alpha")],
                agents: [agent("claudeAgent")],
              });

              expect(result.outcomes).toEqual([
                {
                  skill: refOf(skills, "global", "alpha"),
                  status: "changed",
                  blocked: [],
                  affected: [],
                },
              ]);
              yield* encodeResult(result);
              expect(yield* fs.readLink(path.join(home, ".claude/skills/alpha"))).toBe(
                path.join(home, "library/skills/alpha"),
              );
              const after = (yield* catalog.list({})).skills;
              expect(stateOf(after, "global", "alpha")).toMatchObject({
                claudeAgent: "link",
                codex: "direct",
                antigravity: "none",
              });
              // Nobody else's folders changed.
              expect(yield* fs.exists(path.join(home, ".gemini"))).toBe(false);
            }),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "gives an agent a project skill through a relative link, creating the folder",
      () =>
        Effect.gen(function* () {
          const { fs, path, home, project } = yield* makeMachine;
          yield* withManager(home, [project], ({ manager, catalog }) =>
            Effect.gen(function* () {
              const { skills } = yield* catalog.list({ cwd: project });
              const verify = refOf(skills, "project", "verify");

              const result = yield* manager.enable({
                cwd: project,
                skills: [verify],
                agents: [agent("claudeAgent")],
              });

              expect(result.outcomes[0]?.status).toBe("changed");
              const link = path.join(project, ".claude/skills/verify");
              expect(yield* fs.readLink(link)).toBe("../../.agents/skills/verify");
              expect(yield* fs.realPath(link)).toBe(path.join(project, ".agents/skills/verify"));
            }),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "keeps a project's links working after the project folder is moved",
      () =>
        Effect.gen(function* () {
          const { fs, path, home, project } = yield* makeMachine;
          yield* withManager(home, [project], ({ manager, catalog }) =>
            Effect.gen(function* () {
              const { skills } = yield* catalog.list({ cwd: project });
              yield* manager.enable({
                cwd: project,
                skills: [refOf(skills, "project", "verify")],
                agents: [agent("claudeAgent")],
              });
            }),
          );

          const moved = path.join(home, "repos/app-renamed");
          yield* fs.rename(project, moved);

          expect(yield* fs.realPath(path.join(moved, ".claude/skills/verify"))).toBe(
            path.join(moved, ".agents/skills/verify"),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "turns on for all agents, one link where agents share a folder, and names who else gained it",
      () =>
        Effect.gen(function* () {
          const { fs, path, home } = yield* makeMachine;
          yield* withManager(home, [], ({ manager, catalog }) =>
            Effect.gen(function* () {
              const { skills } = yield* catalog.list({});
              const solo = refOf(skills, "global", "solo");
              // `solo` only lives in Claude's folder, which Cursor and OpenCode read too.
              expect(stateOf(skills, "global", "solo")).toMatchObject({
                claudeAgent: "direct",
                cursor: "direct",
                opencode: "direct",
                codex: "none",
                grok: "none",
                pi: "none",
              });

              const result = yield* manager.enable({ skills: [solo], agents: ALL_AGENTS });

              // Codex, Grok and Pi share ~/.agents/skills, so a single link serves them.
              expect(yield* fs.readLink(path.join(home, ".agents/skills/solo"))).toBe(
                path.join(home, ".claude/skills/solo"),
              );
              expect(result.outcomes[0]).toMatchObject({ status: "changed", blocked: [] });
              // Antigravity reads neither folder, so it gets its own link.
              expect(yield* fs.readLink(path.join(home, ".gemini/config/skills/solo"))).toBe(
                path.join(home, ".claude/skills/solo"),
              );
              const states = stateOf((yield* catalog.list({})).skills, "global", "solo");
              expect(Object.values(states).every((state) => state !== "none")).toBe(true);
            }),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "says which agents that weren't asked for gained the skill from a shared folder",
      () =>
        Effect.gen(function* () {
          const { home } = yield* makeMachine;
          yield* withManager(home, [], ({ manager, catalog }) =>
            Effect.gen(function* () {
              const { skills } = yield* catalog.list({});

              const result = yield* manager.enable({
                skills: [refOf(skills, "global", "solo")],
                agents: [agent("codex")],
              });

              expect(result.outcomes[0]?.affected).toEqual([agent("grok"), agent("pi")]);
              yield* encodeResult(result);
            }),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)("is a no-op the second time", () =>
      Effect.gen(function* () {
        const { home } = yield* makeMachine;
        yield* withManager(home, [], ({ manager, catalog }) =>
          Effect.gen(function* () {
            const { skills } = yield* catalog.list({});
            const input = {
              skills: [refOf(skills, "global", "alpha")],
              agents: [agent("claudeAgent")],
            };

            const first = yield* manager.enable(input);
            const second = yield* manager.enable(input);

            expect(first.outcomes[0]?.status).toBe("changed");
            expect(second.outcomes[0]).toMatchObject({ status: "unchanged", blocked: [] });
          }),
        );
      }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "makes one link when two requests ask at once, and neither fails",
      () =>
        Effect.gen(function* () {
          const { home } = yield* makeMachine;
          yield* withManager(home, [], ({ manager, catalog }) =>
            Effect.gen(function* () {
              const { skills } = yield* catalog.list({});
              const input = {
                skills: [refOf(skills, "global", "alpha")],
                agents: [agent("claudeAgent")],
              };

              const results = yield* Effect.all([manager.enable(input), manager.enable(input)], {
                concurrency: "unbounded",
              });

              expect(results.map((result) => result.outcomes[0]?.status).toSorted()).toEqual([
                "changed",
                "unchanged",
              ]);
            }),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "never replaces a real folder or file where the link would go",
      () =>
        Effect.gen(function* () {
          const { fs, path, home, write } = yield* makeMachine;
          // Claude's folder holds its own `alpha` without a SKILL.md, and a file named `beta`.
          yield* write(".claude/skills/alpha/mine.md", "my own notes");
          yield* write(".claude/skills/beta", "a file");
          yield* withManager(home, [], ({ manager, catalog }) =>
            Effect.gen(function* () {
              const { skills } = yield* catalog.list({});
              const beta = path.join(home, ".agents/skills/beta");
              yield* fs.symlink(path.join(home, "library/skills/beta"), beta);
              const listed = (yield* catalog.list({})).skills;

              const result = yield* manager.enable({
                skills: [refOf(skills, "global", "alpha"), refOf(listed, "global", "beta")],
                agents: [agent("claudeAgent")],
              });

              expect(result.outcomes.map(({ status, blocked }) => ({ status, blocked }))).toEqual([
                {
                  status: "skipped",
                  blocked: [{ instanceId: "claudeAgent", reason: "entryTaken" }],
                },
                {
                  status: "skipped",
                  blocked: [{ instanceId: "claudeAgent", reason: "entryTaken" }],
                },
              ]);
              yield* encodeResult(result);
              expect(
                yield* fs.readFileString(path.join(home, ".claude/skills/alpha/mine.md")),
              ).toBe("my own notes");
              expect(yield* fs.readFileString(path.join(home, ".claude/skills/beta"))).toBe(
                "a file",
              );
            }),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)("never points a link that is there somewhere else", () =>
      Effect.gen(function* () {
        const { fs, path, home, link } = yield* makeMachine;
        // Claude's own `alpha` is already a link, to the other skill.
        yield* link("library/skills/beta", ".claude/skills/alpha");
        yield* withManager(home, [], ({ manager, catalog }) =>
          Effect.gen(function* () {
            const { skills } = yield* catalog.list({});

            const result = yield* manager.enable({
              skills: [refOf(skills, "global", "alpha")],
              agents: [agent("claudeAgent")],
            });

            expect(result.outcomes[0]?.blocked).toEqual([
              { instanceId: "claudeAgent", reason: "entryTaken" },
            ]);
            expect(yield* fs.readLink(path.join(home, ".claude/skills/alpha"))).toBe(
              path.join(home, "library/skills/beta"),
            );
          }),
        );
      }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "doesn't link a skill the agent would never load because another comes first",
      () =>
        Effect.gen(function* () {
          const { fs, path, home, project, write } = yield* makeMachine;
          // Claude reads its global folder before the project's, so a global `verify` wins.
          yield* write(".claude/skills/verify/SKILL.md", skillFile("verify"));
          yield* withManager(home, [project], ({ manager, catalog }) =>
            Effect.gen(function* () {
              const { skills } = yield* catalog.list({ cwd: project });

              const result = yield* manager.enable({
                cwd: project,
                skills: [refOf(skills, "project", "verify")],
                agents: [agent("claudeAgent"), agent("codex")],
              });

              expect(result.outcomes[0]).toMatchObject({
                status: "skipped",
                blocked: [{ instanceId: "claudeAgent", reason: "shadowed" }],
              });
              expect(yield* fs.exists(path.join(project, ".claude"))).toBe(false);
            }),
          );
        }),
    );
  });

  describe("disable", () => {
    it.effect.skipIf(!symlinksSupported)(
      "removes the agent's link and leaves the skill's own folder and every other link",
      () =>
        Effect.gen(function* () {
          const { fs, path, home } = yield* makeMachine;
          yield* withManager(home, [], ({ manager, catalog }) =>
            Effect.gen(function* () {
              const { skills } = yield* catalog.list({});
              const alpha = refOf(skills, "global", "alpha");
              yield* manager.enable({ skills: [alpha], agents: [agent("claudeAgent")] });

              const result = yield* manager.disable({
                skills: [alpha],
                agents: [agent("claudeAgent")],
              });

              expect(result.outcomes[0]).toEqual({
                skill: alpha,
                status: "changed",
                blocked: [],
                affected: [],
              });
              yield* encodeResult(result);
              expect(yield* fs.exists(path.join(home, ".claude/skills/alpha"))).toBe(false);
              expect(
                yield* fs.readFileString(path.join(home, "library/skills/alpha/notes.md")),
              ).toBe("notes on alpha");
              expect(yield* fs.exists(path.join(home, ".agents/skills/alpha"))).toBe(true);
              expect(stateOf((yield* catalog.list({})).skills, "global", "alpha")).toMatchObject({
                claudeAgent: "none",
                codex: "direct",
              });
            }),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "refuses for an agent that reads the skill's folder, changing nothing",
      () =>
        Effect.gen(function* () {
          const { fs, path, home } = yield* makeMachine;
          yield* withManager(home, [], ({ manager, catalog }) =>
            Effect.gen(function* () {
              const { skills } = yield* catalog.list({});

              const result = yield* manager.disable({
                skills: [refOf(skills, "global", "alpha"), refOf(skills, "global", "solo")],
                // Cursor reads the shared folder the alpha link is in and Claude's own folder
                // that solo is in, and has no setting that names a skill.
                agents: [agent("cursor")],
              });

              expect(result.outcomes.map(({ status, blocked }) => ({ status, blocked }))).toEqual([
                {
                  status: "skipped",
                  blocked: [{ instanceId: "cursor", reason: "alwaysOn" }],
                },
                {
                  status: "skipped",
                  blocked: [{ instanceId: "cursor", reason: "alwaysOn" }],
                },
              ]);
              expect(yield* fs.exists(path.join(home, ".agents/skills/alpha"))).toBe(true);
              expect(yield* fs.exists(path.join(home, ".claude/skills/solo/SKILL.md"))).toBe(true);
            }),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "names the other agents that lose the skill with the link",
      () =>
        Effect.gen(function* () {
          const { fs, path, home, link } = yield* makeMachine;
          // `beta` is only linked in Claude's folder, which Cursor and OpenCode read too.
          yield* link("library/skills/beta", ".claude/skills/beta");
          yield* withManager(home, [], ({ manager, catalog }) =>
            Effect.gen(function* () {
              const { skills } = yield* catalog.list({});
              expect(stateOf(skills, "global", "beta")).toMatchObject({
                claudeAgent: "link",
                cursor: "link",
                opencode: "link",
              });

              const result = yield* manager.disable({
                skills: [refOf(skills, "global", "beta")],
                agents: [agent("claudeAgent")],
              });

              expect(result.outcomes[0]).toMatchObject({
                status: "changed",
                affected: [agent("cursor"), agent("opencode")],
              });
              expect(yield* fs.exists(path.join(home, "library/skills/beta/SKILL.md"))).toBe(true);
            }),
          );
        }),
    );
  });

  describe("place", () => {
    /** Claude reads a project skill through a link made by turning it on. */
    const withClaudeOnVerify = (
      manager: SkillManager.SkillManager["Service"],
      project: string,
      verify: SkillRef,
    ) => manager.enable({ cwd: project, skills: [verify], agents: [agent("claudeAgent")] });

    it.effect.skipIf(!symlinksSupported)(
      "moves a project skill to Global, and each agent's link follows",
      () =>
        Effect.gen(function* () {
          const { fs, path, home, project } = yield* makeMachine;
          yield* withManager(home, [project], ({ manager, catalog }) =>
            Effect.gen(function* () {
              const verify = refOf(
                (yield* catalog.list({ cwd: project })).skills,
                "project",
                "verify",
              );
              yield* withClaudeOnVerify(manager, project, verify);
              expect(yield* fs.readLink(path.join(project, ".claude/skills/verify"))).toBe(
                "../../.agents/skills/verify",
              );

              const result = yield* manager.place({
                cwd: project,
                skills: [verify],
                to: { kind: "global" },
              });

              // Grok reads the shared global folder but not the project's, so it gets the skill.
              expect(result.outcomes).toEqual([
                { skill: verify, status: "changed", blocked: [], affected: [agent("grok")] },
              ]);
              yield* encodeResult(result);
              const moved = path.join(home, ".agents/skills/verify");
              expect(yield* fs.readFileString(path.join(moved, "run.sh"))).toBe("echo ok");
              expect(yield* fs.exists(path.join(project, ".agents/skills/verify"))).toBe(false);
              // The project's link would lead nowhere; the agents that need one get it in Global.
              expect(yield* fs.readDirectory(path.join(project, ".claude/skills"))).toEqual([]);
              expect(yield* fs.readLink(path.join(home, ".claude/skills/verify"))).toBe(moved);
              expect(yield* fs.readLink(path.join(home, ".gemini/config/skills/verify"))).toBe(
                moved,
              );
              const after = (yield* catalog.list({ cwd: project })).skills;
              expect(
                after.some((skill) => skill.scope === "project" && skill.name === "verify"),
              ).toBe(false);
              expect(stateOf(after, "global", "verify")).toEqual({
                claudeAgent: "link",
                codex: "direct",
                cursor: "direct",
                grok: "direct",
                opencode: "direct",
                antigravity: "link",
                pi: "direct",
              });
            }),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "refuses a project that isn't registered, whether it is the list's or a destination",
      () =>
        Effect.gen(function* () {
          const { fs, path, home, project } = yield* makeMachine;
          yield* withManager(home, [project], ({ manager, catalog }) =>
            Effect.gen(function* () {
              const verify = refOf(
                (yield* catalog.list({ cwd: project })).skills,
                "project",
                "verify",
              );
              const stranger = path.join(home, "repos/stranger");

              for (const input of [
                { cwd: stranger, skills: [verify], to: { kind: "global" } },
                { cwd: project, skills: [verify], to: { kind: "project", cwd: stranger } },
                {
                  cwd: project,
                  skills: [verify],
                  to: { kind: "projects", cwds: [project, stranger] },
                },
              ] as const) {
                const error = yield* manager.place(input).pipe(Effect.flip);
                expect(error).toEqual(new SkillRequestError({ reason: "projectNotRegistered" }));
              }
              expect(yield* fs.exists(path.join(project, ".agents/skills/verify/SKILL.md"))).toBe(
                true,
              );
            }),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "moves a skill in an agent's own folder to this project, and the agent keeps it",
      () =>
        Effect.gen(function* () {
          const { fs, path, home, project } = yield* makeMachine;
          yield* withManager(home, [project], ({ manager, catalog }) =>
            Effect.gen(function* () {
              const solo = refOf((yield* catalog.list({ cwd: project })).skills, "global", "solo");

              const result = yield* manager.place({
                cwd: project,
                skills: [solo],
                to: { kind: "project", cwd: project },
              });

              expect(result.outcomes[0]).toMatchObject({ status: "changed", blocked: [] });
              // Codex, Antigravity and Pi read the project's shared folder; they hadn't the skill.
              expect(result.outcomes[0]?.affected.toSorted()).toEqual(
                [agent("antigravity"), agent("codex"), agent("pi")].toSorted(),
              );
              const moved = path.join(project, ".agents/skills/solo");
              expect(yield* fs.exists(path.join(moved, "SKILL.md"))).toBe(true);
              expect(yield* fs.exists(path.join(home, ".claude/skills/solo"))).toBe(false);
              // A project's link is relative, so it survives a clone.
              expect(yield* fs.readLink(path.join(project, ".claude/skills/solo"))).toBe(
                "../../.agents/skills/solo",
              );
              expect(
                stateOf((yield* catalog.list({ cwd: project })).skills, "project", "solo"),
              ).toMatchObject({ claudeAgent: "link", codex: "direct", opencode: "direct" });
            }),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "never merges into or replaces a skill of the same name in the other scope",
      () =>
        Effect.gen(function* () {
          const { fs, path, home, project, write } = yield* makeMachine;
          yield* withManager(home, [project], ({ manager, catalog }) =>
            Effect.gen(function* () {
              const verify = refOf(
                (yield* catalog.list({ cwd: project })).skills,
                "project",
                "verify",
              );
              yield* withClaudeOnVerify(manager, project, verify);
              // First something that isn't even a skill is in the way, then a real skill.
              yield* fs.makeDirectory(path.join(home, ".agents/skills/verify"), {
                recursive: true,
              });

              const folder = yield* manager.place({
                cwd: project,
                skills: [verify],
                to: { kind: "global" },
              });
              yield* write(".agents/skills/verify/SKILL.md", skillFile("theirs"));
              const skill = yield* manager.place({
                cwd: project,
                skills: [verify],
                to: { kind: "global" },
              });

              for (const result of [folder, skill]) {
                expect(result.outcomes[0]).toMatchObject({
                  status: "skipped",
                  reason: "destinationTaken",
                });
              }
              expect(
                yield* fs.readFileString(path.join(home, ".agents/skills/verify/SKILL.md")),
              ).toBe(skillFile("theirs"));
              expect(
                yield* fs.readFileString(path.join(project, ".agents/skills/verify/run.sh")),
              ).toBe("echo ok");
              expect(yield* fs.exists(path.join(project, ".claude/skills/verify"))).toBe(true);
              expect(yield* fs.exists(path.join(home, ".claude/skills/verify"))).toBe(false);
            }),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "leaves a skill alone that is only reached through a link, such as a synced library's",
      () =>
        Effect.gen(function* () {
          const { fs, path, home, project } = yield* makeMachine;
          yield* withManager(home, [project], ({ manager, catalog }) =>
            Effect.gen(function* () {
              const { skills } = yield* catalog.list({ cwd: project });
              const alpha = refOf(skills, "global", "alpha");

              const result = yield* manager.place({
                cwd: project,
                skills: [alpha],
                to: { kind: "project", cwd: project },
              });

              expect(result.outcomes[0]).toMatchObject({ status: "skipped", reason: "linked" });
              expect(yield* fs.readLink(path.join(home, ".agents/skills/alpha"))).toBe(
                path.join(home, "library/skills/alpha"),
              );
              expect(yield* fs.exists(path.join(project, ".agents/skills/alpha"))).toBe(false);
              expect(yield* fs.exists(path.join(home, "library/skills/alpha/SKILL.md"))).toBe(true);
            }),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "tells what happened to each skill in a bulk move, and one that can't move doesn't stop the rest",
      () =>
        Effect.gen(function* () {
          const { fs, path, home, project, link } = yield* makeMachine;
          yield* link("library/skills/beta", "repos/app/.agents/skills/synced");
          yield* withManager(home, [project], ({ manager, catalog }) =>
            Effect.gen(function* () {
              const { skills } = yield* catalog.list({ cwd: project });
              const ghost: SkillRef = {
                scope: "project",
                name: "ghost",
                home: ".agents/skills/ghost",
              };

              const result = yield* manager.place({
                cwd: project,
                skills: [
                  refOf(skills, "project", "synced"),
                  ghost,
                  refOf(skills, "project", "verify"),
                ],
                to: { kind: "global" },
              });

              expect(
                result.outcomes.map(({ skill, status, reason }) => [skill.name, status, reason]),
              ).toEqual([
                ["synced", "skipped", "linked"],
                ["ghost", "skipped", "notFound"],
                ["verify", "changed", undefined],
              ]);
              yield* encodeResult(result);
              expect(yield* fs.exists(path.join(home, ".agents/skills/verify/SKILL.md"))).toBe(
                true,
              );
              expect(yield* fs.readLink(path.join(project, ".agents/skills/synced"))).toBe(
                path.join(home, "library/skills/beta"),
              );
            }),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "refuses a skill that isn't where the list said, and a skill that is there already",
      () =>
        Effect.gen(function* () {
          const { fs, path, home, project } = yield* makeMachine;
          yield* withManager(home, [project], ({ manager, catalog }) =>
            Effect.gen(function* () {
              const { skills } = yield* catalog.list({ cwd: project });
              const solo = refOf(skills, "global", "solo");
              const verify = refOf(skills, "project", "verify");
              // `solo` now leads to another folder, so it is no longer what the list showed.
              yield* fs.remove(path.join(home, ".claude/skills/solo"), { recursive: true });
              yield* fs.symlink(
                path.join(home, "library/skills/beta"),
                path.join(home, ".claude/skills/solo"),
              );

              const result = yield* manager.place({
                cwd: project,
                skills: [solo, verify],
                to: { kind: "project", cwd: project },
              });

              expect(result.outcomes.map(({ status, reason }) => ({ status, reason }))).toEqual([
                { status: "skipped", reason: "changed" },
                // It is in this project already.
                { status: "unchanged", reason: undefined },
              ]);
              expect(yield* fs.exists(path.join(project, ".agents/skills/solo"))).toBe(false);
              expect(yield* fs.exists(path.join(project, ".agents/skills/verify/run.sh"))).toBe(
                true,
              );
            }),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "refuses a project folder the environment doesn't know",
      () =>
        Effect.gen(function* () {
          const { fs, path, home, project } = yield* makeMachine;
          yield* withManager(home, [], ({ manager }) =>
            Effect.gen(function* () {
              // The list itself refuses a folder that isn't a project, so name the skill as a
              // client holding an older list would.
              const verify: SkillRef = {
                scope: "project",
                name: "verify",
                home: ".agents/skills/verify",
              };

              const error = yield* manager
                .place({ cwd: project, skills: [verify], to: { kind: "global" } })
                .pipe(Effect.flip);

              expect(error).toEqual(new SkillRequestError({ reason: "projectNotRegistered" }));
              expect(yield* fs.exists(path.join(project, ".agents/skills/verify/SKILL.md"))).toBe(
                true,
              );
              expect(yield* fs.exists(path.join(home, ".agents/skills/verify"))).toBe(false);
            }),
          );
        }),
    );

    describe("across filesystems", () => {
      /** The skill's own folder can't be renamed, as when the project is on another disk. */
      const onAnotherDisk = (fs: FileSystem.FileSystem, from: string) =>
        FileSystem.FileSystem.of({
          ...fs,
          rename: (oldPath, newPath) =>
            oldPath === from
              ? Effect.fail(
                  PlatformError.systemError({
                    _tag: "Unknown",
                    module: "FileSystem",
                    method: "rename",
                    pathOrDescriptor: oldPath,
                    cause: Object.assign(new Error("EXDEV"), { code: "EXDEV" }),
                  }),
                )
              : fs.rename(oldPath, newPath),
        });

      it.effect.skipIf(!symlinksSupported)(
        "copies the skill over, and the agents' links follow just the same",
        () =>
          Effect.gen(function* () {
            const { fs, path, home, project } = yield* makeMachine;
            const from = path.join(project, ".agents/skills/verify");
            yield* withManager(home, [project], ({ manager, catalog }) =>
              Effect.gen(function* () {
                const verify = refOf(
                  (yield* catalog.list({ cwd: project })).skills,
                  "project",
                  "verify",
                );
                yield* withClaudeOnVerify(manager, project, verify);

                const result = yield* manager.place({
                  cwd: project,
                  skills: [verify],
                  to: { kind: "global" },
                });

                expect(result.outcomes[0]).toMatchObject({ status: "changed", blocked: [] });
                const moved = path.join(home, ".agents/skills/verify");
                expect(yield* fs.readFileString(path.join(moved, "run.sh"))).toBe("echo ok");
                expect(yield* fs.exists(from)).toBe(false);
                expect(yield* fs.readDirectory(path.join(project, ".claude/skills"))).toEqual([]);
                expect(yield* fs.readLink(path.join(home, ".claude/skills/verify"))).toBe(moved);
                const left = yield* fs.readDirectory(path.join(home, ".agents/skills"));
                expect(left.filter((name) => name.startsWith(".t3-moving"))).toEqual([]);
              }),
            ).pipe(Effect.provideService(FileSystem.FileSystem, onAnotherDisk(fs, from)));
          }),
      );

      it.effect.skipIf(!symlinksSupported)(
        "leaves the skill and its links as they were when the copy fails",
        () =>
          Effect.gen(function* () {
            const { fs, path, home, project } = yield* makeMachine;
            const from = path.join(project, ".agents/skills/verify");
            const failing = FileSystem.FileSystem.of({
              ...onAnotherDisk(fs, from),
              copyFile: (source) =>
                Effect.fail(
                  PlatformError.systemError({
                    _tag: "Unknown",
                    module: "FileSystem",
                    method: "copyFile",
                    pathOrDescriptor: source,
                    cause: Object.assign(new Error("EIO"), { code: "EIO" }),
                  }),
                ),
            });
            yield* withManager(home, [project], ({ manager, catalog }) =>
              Effect.gen(function* () {
                const verify = refOf(
                  (yield* catalog.list({ cwd: project })).skills,
                  "project",
                  "verify",
                );
                yield* withClaudeOnVerify(manager, project, verify);

                const result = yield* manager.place({
                  cwd: project,
                  skills: [verify],
                  to: { kind: "global" },
                });

                expect(result.outcomes[0]).toMatchObject({ status: "skipped", reason: "failed" });
                expect(yield* fs.readFileString(path.join(from, "run.sh"))).toBe("echo ok");
                expect(yield* fs.readLink(path.join(project, ".claude/skills/verify"))).toBe(
                  "../../.agents/skills/verify",
                );
                expect(yield* fs.exists(path.join(home, ".agents/skills/verify"))).toBe(false);
                expect(yield* fs.readDirectory(path.join(home, ".agents/skills"))).toEqual([
                  "alpha",
                ]);
              }),
            ).pipe(Effect.provideService(FileSystem.FileSystem, failing));
          }),
      );
    });
  });

  describe("delete", () => {
    it.effect.skipIf(!symlinksSupported)(
      "deletes the skill's folder and every link to it, and nothing else",
      () =>
        Effect.gen(function* () {
          const { fs, path, home, project } = yield* makeMachine;
          yield* withManager(home, [project], ({ manager, catalog }) =>
            Effect.gen(function* () {
              const { skills } = yield* catalog.list({ cwd: project });
              const verify = refOf(skills, "project", "verify");
              yield* manager.enable({
                cwd: project,
                skills: [verify],
                agents: [agent("claudeAgent")],
              });

              const result = yield* manager.delete({ cwd: project, skills: [verify] });

              expect(result.outcomes[0]).toMatchObject({ status: "changed", blocked: [] });
              expect(result.outcomes[0]?.affected).toContain(agent("claudeAgent"));
              expect(result.outcomes[0]?.affected).toContain(agent("codex"));
              yield* encodeResult(result);
              expect(yield* fs.exists(path.join(project, ".agents/skills/verify"))).toBe(false);
              expect(yield* fs.readDirectory(path.join(project, ".claude/skills"))).toEqual([]);
              // The folders around it, and everything else, are as they were.
              expect(yield* fs.exists(path.join(project, ".agents/skills"))).toBe(true);
              expect(yield* fs.exists(path.join(home, ".claude/skills/solo/SKILL.md"))).toBe(true);
              expect(yield* fs.exists(path.join(home, "library/skills/alpha/SKILL.md"))).toBe(true);
              expect(
                (yield* catalog.list({ cwd: project })).skills.some(
                  (skill) => skill.name === "verify",
                ),
              ).toBe(false);
            }),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "takes away the links that lead to a global skill from a project too",
      () =>
        Effect.gen(function* () {
          const { fs, path, home, project, link } = yield* makeMachine;
          yield* link(".claude/skills/solo", "repos/app/.claude/skills/solo");
          yield* withManager(home, [project], ({ manager, catalog }) =>
            Effect.gen(function* () {
              const solo = refOf((yield* catalog.list({ cwd: project })).skills, "global", "solo");

              const result = yield* manager.delete({ cwd: project, skills: [solo] });

              expect(result.outcomes[0]).toMatchObject({ status: "changed" });
              expect(yield* fs.exists(path.join(home, ".claude/skills/solo"))).toBe(false);
              const left = yield* fs.readDirectory(path.join(project, ".claude/skills"));
              expect(left).not.toContain("solo");
            }),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "doesn't delete what a link leads to: a synced library's skill stays",
      () =>
        Effect.gen(function* () {
          const { fs, path, home } = yield* makeMachine;
          yield* withManager(home, [], ({ manager, catalog }) =>
            Effect.gen(function* () {
              const alpha = refOf((yield* catalog.list({})).skills, "global", "alpha");

              const result = yield* manager.delete({ skills: [alpha] });

              expect(result.outcomes[0]).toMatchObject({ status: "skipped", reason: "linked" });
              expect(
                yield* fs.readFileString(path.join(home, "library/skills/alpha/notes.md")),
              ).toBe("notes on alpha");
              expect(yield* fs.exists(path.join(home, ".agents/skills/alpha"))).toBe(true);
            }),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "tells what happened to each skill in a bulk delete, and refuses a stale one",
      () =>
        Effect.gen(function* () {
          const { fs, path, home, project } = yield* makeMachine;
          yield* withManager(home, [project], ({ manager, catalog }) =>
            Effect.gen(function* () {
              const { skills } = yield* catalog.list({ cwd: project });
              const verify = refOf(skills, "project", "verify");
              const solo = refOf(skills, "global", "solo");
              const alpha = refOf(skills, "global", "alpha");
              const ghost: SkillRef = { scope: "global", name: "ghost", home: "~/ghost" };
              // `solo` was swapped for a link to another folder since the list was read.
              yield* fs.remove(path.join(home, ".claude/skills/solo"), { recursive: true });
              yield* fs.symlink(
                path.join(home, "library/skills/beta"),
                path.join(home, ".claude/skills/solo"),
              );

              const result = yield* manager.delete({
                cwd: project,
                skills: [verify, solo, alpha, ghost],
              });

              expect(
                result.outcomes.map(({ skill, status, reason }) => [skill.name, status, reason]),
              ).toEqual([
                ["verify", "changed", undefined],
                ["solo", "skipped", "changed"],
                ["alpha", "skipped", "linked"],
                ["ghost", "skipped", "notFound"],
              ]);
              expect(yield* fs.exists(path.join(home, "library/skills/beta/SKILL.md"))).toBe(true);
            }),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "refuses a project folder the environment doesn't know",
      () =>
        Effect.gen(function* () {
          const { fs, path, home, project } = yield* makeMachine;
          yield* withManager(home, [], ({ manager }) =>
            Effect.gen(function* () {
              // The list itself refuses a folder that isn't a project, so name the skill as a
              // client holding an older list would.
              const verify: SkillRef = {
                scope: "project",
                name: "verify",
                home: ".agents/skills/verify",
              };

              const error = yield* manager
                .delete({ cwd: project, skills: [verify] })
                .pipe(Effect.flip);

              expect(error).toEqual(new SkillRequestError({ reason: "projectNotRegistered" }));
              expect(yield* fs.exists(path.join(project, ".agents/skills/verify/SKILL.md"))).toBe(
                true,
              );
            }),
          );
        }),
    );
  });

  describe("the picker refresh", () => {
    it.effect.skipIf(!symlinksSupported)(
      "refreshes the agents whose skills changed, once, and nothing after a no-op or a refusal",
      () =>
        Effect.gen(function* () {
          const { home } = yield* makeMachine;
          yield* withManager(home, [], ({ manager, catalog, refreshes }) =>
            Effect.gen(function* () {
              const { skills } = yield* catalog.list({});
              const alpha = refOf(skills, "global", "alpha");
              const ghost: SkillRef = { scope: "global", name: "ghost", home: "~/ghost" };
              // Codex reads the skill already, and the other one isn't there: nothing is written.
              yield* manager.enable({ skills: [alpha, ghost], agents: [agent("codex")] });
              yield* manager.disable({ skills: [alpha], agents: [agent("claudeAgent")] });

              yield* manager.enable({ skills: [alpha], agents: [agent("claudeAgent")] });

              // Anything the two no-ops had asked for would come first.
              expect(yield* Queue.take(refreshes)).toEqual({
                instanceId: agent("claudeAgent"),
                cwd: undefined,
                fresh: undefined,
              });
              expect(yield* Queue.size(refreshes)).toBe(0);
            }),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "refreshes the open project's list for each agent that gained or lost the skill",
      () =>
        Effect.gen(function* () {
          const { home, project } = yield* makeMachine;
          yield* withManager(home, [project], ({ manager, catalog, refreshes }) =>
            Effect.gen(function* () {
              const { skills } = yield* catalog.list({ cwd: project });
              const verify = refOf(skills, "project", "verify");

              // A skill that is already on for the agent asked for changes nothing.
              yield* manager.enable({ cwd: project, skills: [verify], agents: [agent("codex")] });
              yield* manager.enable({
                cwd: project,
                skills: [verify],
                agents: [agent("claudeAgent")],
              });
              yield* manager.disable({
                cwd: project,
                skills: [verify],
                agents: [agent("claudeAgent")],
              });

              const asked = yield* Effect.forEach([1, 2], () => Queue.take(refreshes));
              expect(asked).toEqual([
                { instanceId: agent("claudeAgent"), cwd: project, fresh: true },
                { instanceId: agent("claudeAgent"), cwd: project, fresh: true },
              ]);
              expect(yield* Queue.size(refreshes)).toBe(0);
            }),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "refreshes every agent a move or a delete touches, and none when the move is refused",
      () =>
        Effect.gen(function* () {
          const { home, project } = yield* makeMachine;
          yield* withManager(home, [project], ({ manager, catalog, refreshes }) =>
            Effect.gen(function* () {
              const { skills } = yield* catalog.list({ cwd: project });
              const alpha = refOf(skills, "global", "alpha");
              const verify = refOf(skills, "project", "verify");
              const solo = refOf(skills, "global", "solo");
              const touched = (count: number) =>
                Effect.forEach(Array.from({ length: count }), () => Queue.take(refreshes)).pipe(
                  Effect.map((asked) => asked.map((item) => item.instanceId).toSorted()),
                );

              // A skill reached through a link can't move: nothing was written, so nothing refreshes.
              yield* manager.place({
                cwd: project,
                skills: [alpha],
                to: { kind: "project", cwd: project },
              });
              yield* manager.place({ cwd: project, skills: [verify], to: { kind: "global" } });
              // Claude never used it. The other six did, or do now, or both.
              expect(yield* touched(6)).toEqual(
                ALL_AGENTS.filter((id) => id !== agent("claudeAgent")).toSorted(),
              );
              expect(yield* Queue.size(refreshes)).toBe(0);

              yield* manager.delete({ cwd: project, skills: [solo] });
              // Claude, Cursor and OpenCode read the global `.claude/skills` folder.
              expect(yield* touched(3)).toEqual(
                [agent("claudeAgent"), agent("cursor"), agent("opencode")].toSorted(),
              );
            }),
          );
        }),
    );
  });

  describe("requests", () => {
    it.effect.skipIf(!symlinksSupported)(
      "refuses to write when the skill is no longer where the list said, or gone",
      () =>
        Effect.gen(function* () {
          const { fs, path, home } = yield* makeMachine;
          yield* withManager(home, [], ({ manager, catalog }) =>
            Effect.gen(function* () {
              const { skills } = yield* catalog.list({});
              const alpha = refOf(skills, "global", "alpha");
              // The shared folder's `alpha` now leads to another folder.
              yield* fs.remove(path.join(home, ".agents/skills/alpha"));
              yield* fs.symlink(
                path.join(home, "library/skills/beta"),
                path.join(home, ".agents/skills/alpha"),
              );

              const result = yield* manager.enable({
                skills: [alpha, { scope: "global", name: "ghost", home: "~/ghost" }],
                agents: [agent("claudeAgent")],
              });

              expect(result.outcomes.map(({ status, reason }) => ({ status, reason }))).toEqual([
                { status: "skipped", reason: "changed" },
                { status: "skipped", reason: "notFound" },
              ]);
              yield* encodeResult(result);
              expect(yield* fs.exists(path.join(home, ".claude/skills/alpha"))).toBe(false);
            }),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "refuses a project folder the environment doesn't know, and an agent it doesn't have",
      () =>
        Effect.gen(function* () {
          const { fs, path, home, project } = yield* makeMachine;
          yield* withManager(home, [], ({ manager }) =>
            Effect.gen(function* () {
              // The list itself refuses a folder that isn't a project, so name the skill as a
              // client holding an older list would.
              const verify: SkillRef = {
                scope: "project",
                name: "verify",
                home: ".agents/skills/verify",
              };

              const unregistered = yield* manager
                .enable({ cwd: project, skills: [verify], agents: [agent("claudeAgent")] })
                .pipe(Effect.flip);
              expect(unregistered).toEqual(
                new SkillRequestError({ reason: "projectNotRegistered" }),
              );
              expect(yield* fs.exists(path.join(project, ".claude"))).toBe(false);
            }),
          );
          yield* withManager(home, [project], ({ manager, catalog }) =>
            Effect.gen(function* () {
              const { skills } = yield* catalog.list({ cwd: project });

              const unknown = yield* manager
                .enable({
                  cwd: project,
                  skills: [refOf(skills, "project", "verify")],
                  agents: [agent("not-an-agent")],
                })
                .pipe(Effect.flip);
              expect(unknown).toEqual(new SkillRequestError({ reason: "unknownAgent" }));
            }),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "tells what happened to each skill in a bulk request, and one bad skill doesn't stop the rest",
      () =>
        Effect.gen(function* () {
          const { home, project } = yield* makeMachine;
          yield* withManager(home, [project], ({ manager, catalog }) =>
            Effect.gen(function* () {
              const { skills } = yield* catalog.list({ cwd: project });
              const alpha = refOf(skills, "global", "alpha");
              const ghost: SkillRef = { scope: "global", name: "ghost", home: "~/ghost" };
              const verify = refOf(skills, "project", "verify");
              const solo = refOf(skills, "global", "solo");

              const result = yield* manager.enable({
                cwd: project,
                skills: [alpha, ghost, verify, solo],
                agents: [agent("claudeAgent")],
              });

              expect(
                result.outcomes.map(({ skill, status }) => [skill.name, status] as const),
              ).toEqual([
                ["alpha", "changed"],
                ["ghost", "skipped"],
                ["verify", "changed"],
                // Claude reads solo's folder itself.
                ["solo", "unchanged"],
              ]);
              yield* encodeResult(result);
            }),
          );
        }),
    );
  });
});

describe("the request and result schemas", () => {
  const ref = { scope: "global", name: "alpha", home: "~/alpha" } as const;
  const decodes = (schema: Schema.Decoder<unknown>, input: unknown) =>
    Schema.decodeUnknownOption(schema)(input).pipe(Option.isSome);

  it("accepts a request for some skills and agents", () => {
    expect(decodes(SkillEnableInput, { skills: [ref], agents: ["claudeAgent"] })).toBe(true);
    expect(decodes(SkillDisableInput, { cwd: "/repo", skills: [ref], agents: ["codex"] })).toBe(
      true,
    );
  });

  it("rejects a request for no skills, no agents or too many skills", () => {
    expect(decodes(SkillEnableInput, { skills: [], agents: ["codex"] })).toBe(false);
    expect(decodes(SkillEnableInput, { skills: [ref], agents: [] })).toBe(false);
    expect(decodes(SkillDeleteInput, { skills: Array.from({ length: 201 }, () => ref) })).toBe(
      false,
    );
    expect(decodes(SkillDeleteInput, { skills: Array.from({ length: 200 }, () => ref) })).toBe(
      true,
    );
  });

  it("accepts a request to place skills in a project, in Global or in some projects", () => {
    const to = [
      { kind: "project", cwd: "/repo" },
      { kind: "global" },
      { kind: "projects", cwds: ["/repo", "/other"] },
    ];
    for (const placement of to) {
      expect(decodes(SkillPlaceInput, { skills: [ref], to: placement })).toBe(true);
      expect(decodes(SkillPlaceInput, { cwd: "/repo", skills: [ref], to: placement })).toBe(true);
    }
    expect(decodes(SkillDeleteInput, { skills: [ref] })).toBe(true);
  });

  it("rejects a placement with no skills, no destination, or a destination it can't use", () => {
    expect(decodes(SkillPlaceInput, { skills: [], to: { kind: "global" } })).toBe(false);
    expect(decodes(SkillPlaceInput, { skills: [ref] })).toBe(false);
    expect(decodes(SkillPlaceInput, { skills: [ref], to: { kind: "project" } })).toBe(false);
    expect(decodes(SkillPlaceInput, { skills: [ref], to: { kind: "elsewhere" } })).toBe(false);
    expect(decodes(SkillPlaceInput, { skills: [ref], to: "global" })).toBe(false);
    expect(decodes(SkillPlaceInput, { skills: [ref], to: { kind: "projects", cwds: [] } })).toBe(
      false,
    );
    const cwds = (count: number) => Array.from({ length: count }, (_, index) => `/repo-${index}`);
    expect(
      decodes(SkillPlaceInput, { skills: [ref], to: { kind: "projects", cwds: cwds(65) } }),
    ).toBe(false);
    expect(
      decodes(SkillPlaceInput, { skills: [ref], to: { kind: "projects", cwds: cwds(64) } }),
    ).toBe(true);
    expect(decodes(SkillDeleteInput, { skills: [] })).toBe(false);
  });

  it("describes a skill by how an agent reaches it, who it is used in and where it came from", () => {
    const summary = {
      name: "alpha",
      scope: "global",
      home: "~/.agents/skill-library/alpha",
      description: "The alpha skill.",
      copies: [],
      access: [
        {
          instanceId: "codex",
          driver: "codex",
          state: "off",
          folder: "~/.agents/skills",
          fixed: false,
        },
        {
          instanceId: "cursor",
          driver: "cursor",
          state: "direct",
          folder: "~/.cursor",
          fixed: true,
        },
      ],
      source: "acme/skills",
      projects: ["/home/user/acme-web"],
    };
    expect(decodes(SkillListResult, { skills: [summary], unreadable: [] })).toBe(true);
    expect(
      decodes(SkillListResult, {
        skills: [{ ...summary, access: [{ ...summary.access[0], state: "maybe" }] }],
        unreadable: [],
      }),
    ).toBe(false);
    expect(
      decodes(SkillListResult, { skills: [{ ...summary, projects: [""] }], unreadable: [] }),
    ).toBe(false);
  });

  it.effect("describes why a skill or an agent was left as it was, for each reason", () =>
    Effect.forEach(["linked", "destinationTaken", "inUse", "setElsewhere"] as const, (reason) =>
      encodeResult({
        outcomes: [
          {
            skill: ref,
            status: "skipped",
            reason,
            blocked: [{ instanceId: "codex", reason }],
            affected: [],
          },
        ],
      }),
    ),
  );
});

describe("planEnable", () => {
  const read = (directory: string, scope: SkillScope, rival = false, standard = false) => ({
    scope,
    directory,
    label: directory,
    standard,
    rival,
  });
  const skill = (
    agents: SkillCatalog.ResolvedSkill["agents"],
    entries: SkillCatalog.ResolvedSkill["entries"] = [],
  ): SkillCatalog.ResolvedSkill => ({
    scope: "project",
    name: "verify",
    displayHome: ".agents/skills/verify",
    home: "/repo/.agents/skills/verify",
    own: true,
    standardFolders: { project: "/repo/.agents/skills", global: "/home/.agents/skills" },
    entries,
    agents,
  });
  const member = (
    instanceId: string,
    collision: "first-wins" | "all",
    reads: ReturnType<typeof read>[],
  ) => ({
    instanceId: agent(instanceId),
    driver: ProviderInstanceId.make(instanceId) as never,
    collision,
    state: "none" as const,
    via: [],
    reads,
  });
  const everyone = new Set(["a", "b"].map((id) => agent(id)));

  it("links in the shared folder when the agent reads it, even when its own folder is first", () => {
    const plan = planEnable(
      skill([
        member("a", "first-wins", [
          read("/repo/.pi/skills", "project"),
          read("/repo/.agents/skills", "project", false, true),
        ]),
      ]),
      everyone,
    );
    expect(plan.links).toEqual([{ directory: "/repo/.agents/skills", agents: [agent("a")] }]);
  });

  it("makes one link for agents that read the same folder, and none where it is there already", () => {
    const shared = [read("/repo/.agents/skills", "project", false, true)];
    expect(
      planEnable(skill([member("a", "all", shared), member("b", "first-wins", shared)]), everyone)
        .links,
    ).toEqual([{ directory: "/repo/.agents/skills", agents: [agent("a"), agent("b")] }]);
    expect(
      planEnable(
        skill(
          [member("a", "all", shared)],
          [{ path: "/repo/.agents/skills/verify", directory: "/repo/.agents/skills", target: "x" }],
        ),
        everyone,
      ).links,
    ).toEqual([]);
  });

  it("holds back an agent that loads another skill with the name first, unless it loads them all", () => {
    const reads = [
      read("/home/.claude/skills", "global", true),
      read("/repo/.claude/skills", "project"),
    ];
    const plan = planEnable(
      skill([member("a", "first-wins", reads), member("b", "all", reads)]),
      everyone,
    );
    expect(plan.blocked).toEqual([{ instanceId: agent("a"), reason: "shadowed" }]);
    expect(plan.links).toEqual([{ directory: "/repo/.claude/skills", agents: [agent("b")] }]);
  });
});
