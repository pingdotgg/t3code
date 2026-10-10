import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  SkillListResult,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type Project,
  type RuntimeMode,
  type SkillSummary,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer } from "effect/ai";

import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ProviderInstanceRegistry from "../../../provider/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as Settings from "../../../serverSettings.ts";
import * as VcsProcess from "../../../vcs/VcsProcess.ts";
import * as SkillCatalog from "../../../skills/SkillCatalog.ts";
import * as SkillManager from "../../../skills/SkillManager.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const threadId = ThreadId.make("skills-mcp-thread");
const projectId = ProjectId.make("skills-mcp-project");
const claudeDriver = ProviderDriverKind.make("claudeAgent");
const callingInstance = ProviderInstanceId.make("codex");

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "skills-mcp", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "skills-mcp", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("skills-mcp-environment"),
  requestNamespace: "skills-mcp-session",
  thread: {
    threadId,
    providerSessionId: "skills-mcp-session",
    providerInstanceId: callingInstance,
  },
  client: undefined,
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
};

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

// Effect returns a declared tool failure as `isError` with its encoded payload as JSON text.
const declaredFailure = (result: McpSchema.CallToolResult) => {
  const text = result.content[0];
  return result.isError === true && text?.type === "text" ? decodeJson(text.text) : undefined;
};

const skillFile = (name: string) => `---\nname: ${name}\ndescription: The ${name} skill.\n---\n`;

/** A made-up machine: `alpha` linked into the shared folder, `beta` in Claude's own folder, and one project. */
const makeMachine = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.realPath(
    yield* fs.makeTempDirectoryScoped({ prefix: "t3code-skills-mcp-" }),
  );
  const write = (relative: string, contents: string) =>
    Effect.gen(function* () {
      const target = path.join(home, relative);
      yield* fs.makeDirectory(path.dirname(target), { recursive: true });
      yield* fs.writeFileString(target, contents);
    });
  yield* write("library/skills/alpha/SKILL.md", skillFile("alpha"));
  // Only Claude (and Cursor) read this folder.
  yield* write(".claude/skills/beta/SKILL.md", skillFile("beta"));
  yield* fs.makeDirectory(path.join(home, ".agents/skills"), { recursive: true });
  yield* fs.symlink(
    path.join(home, "library/skills/alpha"),
    path.join(home, ".agents/skills/alpha"),
  );
  yield* write("repos/app/.agents/skills/verify/SKILL.md", skillFile("verify"));
  return { fs, path, home, project: path.join(home, "repos/app") };
});

const projectAt = (workspaceRoot: string): Project => ({
  id: projectId,
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

type Refresh = {
  readonly instanceId: ProviderInstanceId;
  readonly cwd: string | undefined;
  readonly fresh: boolean | undefined;
};

/**
 * The production skills registration over the real catalog and manager, on the machine at `home`.
 * The provider registry is a stand-in that queues each picker refresh it is asked for.
 */
const layerFor = (
  home: string,
  project: string,
  options: {
    readonly refreshes?: Queue.Queue<Refresh>;
    readonly runtimeMode?: RuntimeMode;
    readonly providerInstances?: NonNullable<
      Parameters<typeof Settings.layerTest>[0]
    >["providerInstances"];
  } = {},
) => {
  const noteRefresh = (refresh: Refresh) =>
    (options.refreshes === undefined ? Effect.void : Queue.offer(options.refreshes, refresh)).pipe(
      Effect.as([]),
    );
  return McpHttpServer.layerSkillsToolkit.pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provide(
      SkillManager.layer.pipe(
        Layer.provideMerge(
          SkillCatalog.layer.pipe(
            Layer.provide(
              Settings.layerTest({
                providerInstances: {
                  ...Object.fromEntries(
                    ["cursor", "grok"].map((driver) => [
                      ProviderInstanceId.make(driver),
                      { driver: ProviderDriverKind.make(driver), enabled: true },
                    ]),
                  ),
                  ...options.providerInstances,
                },
              }),
            ),
          ),
        ),
      ),
    ),
    Layer.provide(
      Layer.mock(ProviderRegistry.ProviderRegistry)({
        refreshInstance: (instanceId) =>
          noteRefresh({ instanceId, cwd: undefined, fresh: undefined }),
        refreshWorkspaceSnapshot: ({ instanceId, cwd, fresh }) =>
          noteRefresh({ instanceId, cwd, fresh }),
      }),
    ),
    // No agent here has a settings writer, so none is ever looked up.
    Layer.provide(
      Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
        getInstance: () => Effect.succeed(undefined),
      }),
    ),
    Layer.provide(
      Layer.mock(ProjectService.ProjectService)({
        getById: (id) =>
          Effect.succeed(id === projectId ? Option.some(projectAt(project)) : Option.none()),
        getByWorkspaceRoot: (root) =>
          Effect.succeed(root === project ? Option.some(projectAt(project)) : Option.none()),
      }),
    ),
    Layer.provide(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () =>
          Effect.succeed({
            id: threadId,
            projectId,
            providerInstanceId: callingInstance,
            runtimeMode: options.runtimeMode ?? "full-access",
            interactionMode: "default",
            activeRunId: RunId.make("skills-mcp-run"),
            archivedAt: null,
            deletedAt: null,
          } as OrchestrationV2ThreadShell),
      }),
    ),
    // The manager keeps the links it makes out of git, so it runs git.
    Layer.provide(VcsProcess.layer),
    Layer.provide(Layer.succeed(HostProcess.Environment, { HOME: home })),
    Layer.provide(Layer.succeed(HostProcess.HomeDirectory, home)),
  );
};

const call = (name: string, args: Record<string, unknown>) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server
      .callTool({ name, arguments: args })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
  });

const decodeList = Schema.decodeUnknownSync(SkillListResult);
const listSkills = (args: Record<string, unknown> = {}) =>
  call("t3_skill_list", args).pipe(
    Effect.map((result) => decodeList(result.structuredContent).skills),
  );

const refOf = (skills: ReadonlyArray<SkillSummary>, scope: "project" | "global", name: string) => {
  const skill = skills.find((item) => item.scope === scope && item.name === name);
  if (!skill) throw new Error(`No ${scope} skill ${name} in the list`);
  return { scope, name, home: skill.home };
};

const stateOf = (skills: ReadonlyArray<SkillSummary>, scope: "project" | "global", name: string) =>
  Object.fromEntries(
    (skills.find((item) => item.scope === scope && item.name === name)?.access ?? []).map(
      (entry) => [entry.instanceId, entry.state],
    ),
  );

describe("skills MCP tools", () => {
  it.layer(NodeServices.layer, { excludeTestServices: true })("over a real skill layout", (it) => {
    it.effect("lists the calling thread's project skills and the global ones", () =>
      Effect.gen(function* () {
        const { home, project } = yield* makeMachine;
        yield* Effect.gen(function* () {
          const skills = yield* listSkills();

          expect(skills.map((skill) => `${skill.scope}:${skill.name}`)).toEqual([
            "global:alpha",
            "global:beta",
            "project:verify",
          ]);
          expect(stateOf(skills, "global", "alpha")).toMatchObject({
            claudeAgent: "none",
            codex: "direct",
          });
          expect(stateOf(skills, "global", "beta")).toMatchObject({
            claudeAgent: "direct",
            codex: "none",
          });
          // The home an agent passes back to enable is the one the list shows.
          expect(refOf(skills, "project", "verify").home).toBe(".agents/skills/verify");
        }).pipe(Effect.provide(layerFor(home, project)));
      }),
    );

    it.effect("reads one skill's text and files", () =>
      Effect.gen(function* () {
        const { home, project } = yield* makeMachine;
        yield* Effect.gen(function* () {
          const skills = yield* listSkills();
          const result = yield* call("t3_skill_get", refOf(skills, "global", "beta"));

          expect(result.structuredContent).toMatchObject({
            contents: skillFile("beta"),
            files: [{ path: "SKILL.md" }],
          });
        }).pipe(Effect.provide(layerFor(home, project)));
      }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "turns a skill on for a named agent, and the list then shows it",
      () =>
        Effect.gen(function* () {
          const { fs, path, home, project } = yield* makeMachine;
          yield* Effect.gen(function* () {
            const skills = yield* listSkills();

            const result = yield* call("t3_skill_enable", {
              skills: [refOf(skills, "global", "alpha")],
              agents: ["claudeAgent"],
            });

            expect(result.structuredContent).toEqual({
              outcomes: [
                {
                  skill: refOf(skills, "global", "alpha"),
                  status: "changed",
                  blocked: [],
                  affected: [],
                },
              ],
            });
            expect(yield* fs.readLink(path.join(home, ".claude/skills/alpha"))).toBe(
              path.join(home, "library/skills/alpha"),
            );
            expect(stateOf(yield* listSkills(), "global", "alpha").claudeAgent).toBe("link");
          }).pipe(Effect.provide(layerFor(home, project)));
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "turns a project skill on for every agent, using the thread's project",
      () =>
        Effect.gen(function* () {
          const { home, project } = yield* makeMachine;
          yield* Effect.gen(function* () {
            const skills = yield* listSkills();

            const result = yield* call("t3_skill_enable", {
              skills: [refOf(skills, "project", "verify")],
              agents: "all",
            });

            expect(result.structuredContent).toMatchObject({
              outcomes: [{ status: "changed", blocked: [] }],
            });
            const states = stateOf(yield* listSkills(), "project", "verify");
            expect(Object.values(states).every((state) => state !== "none")).toBe(true);
          }).pipe(Effect.provide(layerFor(home, project)));
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "refreshes the thread's project picker for the agent a skill was turned on for",
      () =>
        Effect.gen(function* () {
          const { home, project } = yield* makeMachine;
          const refreshes = yield* Queue.unbounded<Refresh>();
          yield* Effect.gen(function* () {
            const skills = yield* listSkills();

            yield* call("t3_skill_enable", {
              skills: [refOf(skills, "project", "verify")],
              agents: ["claudeAgent"],
            });

            expect(yield* Queue.take(refreshes)).toEqual({
              instanceId: "claudeAgent",
              cwd: project,
              fresh: true,
            });
            expect(yield* Queue.size(refreshes)).toBe(0);
          }).pipe(Effect.provide(layerFor(home, project, { refreshes })));
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "shows an agent why a skill could not be turned off for it",
      () =>
        Effect.gen(function* () {
          const { fs, path, home, project } = yield* makeMachine;
          yield* Effect.gen(function* () {
            const skills = yield* listSkills();

            const result = yield* call("t3_skill_disable", {
              skills: [refOf(skills, "global", "alpha")],
              agents: ["cursor"],
            });

            // Cursor reads the shared folder itself and has no setting for one skill, so there
            // is nothing of its own to remove or write.
            expect(result.isError).toBe(false);
            expect(result.structuredContent).toMatchObject({
              outcomes: [
                { status: "skipped", blocked: [{ instanceId: "cursor", reason: "alwaysOn" }] },
              ],
            });
            expect(yield* fs.exists(path.join(home, ".agents/skills/alpha"))).toBe(true);
          }).pipe(Effect.provide(layerFor(home, project)));
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "turns a skill on for every instance of a driver named by its driver kind",
      () =>
        Effect.gen(function* () {
          const { fs, path, home, project } = yield* makeMachine;
          yield* Effect.gen(function* () {
            const skills = yield* listSkills();
            // Only the two named instances are agents here; no instance is called "claudeAgent".
            expect(stateOf(skills, "global", "alpha")).toMatchObject({
              claude_home: "none",
              claude_work: "none",
            });

            const result = yield* call("t3_skill_enable", {
              skills: [refOf(skills, "global", "alpha")],
              agents: ["claudeAgent"],
            });

            expect(result.structuredContent).toMatchObject({ outcomes: [{ status: "changed" }] });
            expect(yield* fs.readLink(path.join(home, ".claude/skills/alpha"))).toBe(
              path.join(home, "library/skills/alpha"),
            );
            expect(yield* fs.readLink(path.join(home, "work-claude/skills/alpha"))).toBe(
              path.join(home, "library/skills/alpha"),
            );
          }).pipe(
            Effect.provide(
              layerFor(home, project, {
                providerInstances: {
                  [ProviderInstanceId.make("claudeAgent")]: {
                    driver: claudeDriver,
                    enabled: false,
                  },
                  [ProviderInstanceId.make("claude_home")]: { driver: claudeDriver },
                  [ProviderInstanceId.make("claude_work")]: {
                    driver: claudeDriver,
                    config: { homePath: `${home}/work-claude` },
                  },
                },
              }),
            ),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)("turns a skill back off", () =>
      Effect.gen(function* () {
        const { fs, path, home, project } = yield* makeMachine;
        yield* Effect.gen(function* () {
          const skill = refOf(yield* listSkills(), "global", "alpha");
          yield* call("t3_skill_enable", { skills: [skill], agents: ["claudeAgent"] });

          const result = yield* call("t3_skill_disable", {
            skills: [skill],
            agents: ["claudeAgent"],
          });

          expect(result.structuredContent).toMatchObject({ outcomes: [{ status: "changed" }] });
          expect(yield* fs.exists(path.join(home, ".claude/skills/alpha"))).toBe(false);
          // The skill's own folder is untouched.
          expect(yield* fs.exists(path.join(home, "library/skills/alpha/SKILL.md"))).toBe(true);
        }).pipe(Effect.provide(layerFor(home, project)));
      }),
    );

    it.effect("tells the agent when an agent name is not one it has", () =>
      Effect.gen(function* () {
        const { home, project } = yield* makeMachine;
        yield* Effect.gen(function* () {
          const skills = yield* listSkills();

          const result = yield* call("t3_skill_enable", {
            skills: [refOf(skills, "global", "beta")],
            agents: ["no-such-agent"],
          });

          expect(declaredFailure(result)).toMatchObject({
            code: "invalid_request",
            message: "That agent isn't enabled in this environment.",
          });
        }).pipe(Effect.provide(layerFor(home, project)));
      }),
    );

    it.effect("lets a supervised thread read skills but not change them", () =>
      Effect.gen(function* () {
        const { fs, path, home, project } = yield* makeMachine;
        yield* Effect.gen(function* () {
          const skills = yield* listSkills();
          expect(skills.length).toBeGreaterThan(0);

          const result = yield* call("t3_skill_enable", {
            skills: [refOf(skills, "global", "beta")],
            agents: ["codex"],
          });

          expect(declaredFailure(result)).toMatchObject({ code: "capability_denied" });
          expect(yield* fs.exists(path.join(home, ".agents/skills/beta"))).toBe(false);
        }).pipe(Effect.provide(layerFor(home, project, { runtimeMode: "approval-required" })));
      }),
    );

    it.effect("rejects inputs the tools do not accept before touching any service", () =>
      Effect.gen(function* () {
        const { home, project } = yield* makeMachine;
        yield* Effect.gen(function* () {
          const skill = { scope: "global", name: "beta", home: "~/.claude/skills/beta" };
          for (const [name, args] of [
            ["t3_skill_enable", { skills: [skill], agents: [] }],
            ["t3_skill_enable", { skills: [], agents: "all" }],
            ["t3_skill_enable", { skills: [skill], agents: ["not a slug"] }],
            // Only enabling takes "all".
            ["t3_skill_disable", { skills: [skill], agents: "all" }],
            [
              "t3_skill_enable",
              { skills: [{ scope: "everywhere", name: "beta", home: "x" }], agents: "all" },
            ],
          ] as const) {
            const error = yield* call(name, args).pipe(Effect.flip);
            expect(error._tag, `${name} ${Object.keys(args).join()}`).toBe("InvalidParams");
          }
        }).pipe(Effect.provide(layerFor(home, project)));
      }),
    );
  });
});
