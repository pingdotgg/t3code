import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type Project as ProjectRecord,
  type ProjectScript,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { resolveProjectScripts } from "@t3tools/shared/projectScripts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as ThreadLaunch from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Settings from "../../../serverSettings.ts";
import * as ServerConfig from "../../../config.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as ProjectSettingsService from "../../../project/ProjectSettingsService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ProjectHandlersLive } from "./handlers.ts";
import { ProjectToolkit } from "./tools.ts";

it.effect("attributes a launched thread's first message to the calling thread", () =>
  Effect.gen(function* () {
    const sourceThreadId = ThreadId.make("source-thread");
    const projectId = ProjectId.make("project");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const modelSelection = { instanceId: providerInstanceId, model: "gpt-5" };
    const caller = {
      id: sourceThreadId,
      projectId,
      providerInstanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      activeRunId: "active-run",
      archivedAt: null,
      deletedAt: null,
    } as OrchestrationV2ThreadShell;
    let launchedSender: ThreadId | undefined;
    const dependencies = Layer.mergeAll(
      NodeCrypto.layer,
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment"),
        threadId: sourceThreadId,
        providerSessionId: "session",
        providerInstanceId,
        issuedAt: 0,
        capabilities: new Set(["orchestration" as const]),
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () => Effect.succeed(caller),
      }),
      Layer.mock(ThreadLaunch.ThreadLaunchService)({
        launch: (input) => {
          launchedSender = input.initialMessage?.senderThreadId;
          return Effect.succeed({
            threadId: input.threadId,
            projection: {
              thread: { id: input.threadId, projectId, modelSelection },
              runs: [],
            },
            resumed: false,
          } as unknown as ThreadLaunch.ThreadLaunchResult);
        },
      }),
      Layer.mock(Project.ProjectService)({}),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/projects" }),
      NodeServices.layer,
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-source-link-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    );
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(ProjectHandlersLive.pipe(Layer.provide(dependencies))),
    );
    const result = yield* toolkit
      .handle("t3_thread_launch", { title: "Audit", message: "Review the change" })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    expect(result.at(-1)?.result).toMatchObject({ projectId, modelSelection });
    expect(launchedSender).toBe(sourceThreadId);
  }),
);

it.effect("launches a scratch thread into the Scratch project", () =>
  Effect.gen(function* () {
    const sourceThreadId = ThreadId.make("source-thread");
    const scratchProjectId = ProjectId.make("project:scratch");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const modelSelection = { instanceId: providerInstanceId, model: "gpt-5" };
    const caller = {
      id: sourceThreadId,
      projectId: ProjectId.make("project:caller"),
      providerInstanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      activeRunId: "active-run",
      archivedAt: null,
      deletedAt: null,
    } as OrchestrationV2ThreadShell;
    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const dependencies = Layer.mergeAll(
      NodeCrypto.layer,
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment"),
        threadId: sourceThreadId,
        providerSessionId: "session",
        providerInstanceId,
        issuedAt: 0,
        capabilities: new Set(["orchestration" as const]),
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () => Effect.succeed(caller),
      }),
      Layer.mock(ThreadLaunch.ThreadLaunchService)({
        launch: (input) => {
          launched.push(input);
          return Effect.succeed({
            threadId: input.threadId,
            projection: {
              thread: { id: input.threadId, projectId: input.projectId, modelSelection },
              runs: [],
            },
            resumed: false,
          } as unknown as ThreadLaunch.ThreadLaunchResult);
        },
      }),
      Layer.mock(Project.ProjectService)({}),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/projects",
        ensureScratchProject: Effect.succeed({ projectId: scratchProjectId }),
      }),
      NodeServices.layer,
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-scratch-launch-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    );
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(ProjectHandlersLive.pipe(Layer.provide(dependencies))),
    );
    const handle = (params: Parameters<typeof toolkit.handle<"t3_thread_launch">>[1]) =>
      toolkit
        .handle("t3_thread_launch", params)
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));

    const result = yield* handle({ title: "Notes", scratch: true, message: "Draft a list" });
    expect(result.at(-1)?.result).toMatchObject({ projectId: scratchProjectId });
    expect(launched.map((input) => [input.projectId, input.workspaceStrategy])).toEqual([
      [scratchProjectId, { type: "root" }],
    ]);

    const rejected = yield* handle({
      title: "Notes",
      scratch: true,
      projectId: caller.projectId,
    });
    expect(rejected.at(-1)?.result).toMatchObject({ code: "invalid_request" });
    expect(launched).toHaveLength(1);
  }),
);

it.effect("starts a project from just a title when workspaceRoot is omitted", () =>
  Effect.gen(function* () {
    const sourceThreadId = ThreadId.make("source-thread");
    const createdProjectId = ProjectId.make("project:named");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const caller = {
      id: sourceThreadId,
      projectId: ProjectId.make("project:caller"),
      providerInstanceId,
      modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      activeRunId: "active-run",
      archivedAt: null,
      deletedAt: null,
    } as OrchestrationV2ThreadShell;
    const named: Array<string> = [];
    const registered: Array<string> = [];
    const createdProject = {
      id: createdProjectId,
      title: "Pinball Stats",
      workspaceRoot: "/projects/pinball-stats",
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
      deletedAt: null,
    };
    const dependencies = ProjectSettingsService.layer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          NodeCrypto.layer,
          Settings.ServerSettingsService.layerTest(),
          Layer.succeed(McpInvocationContext.McpInvocationContext, {
            environmentId: EnvironmentId.make("environment"),
            threadId: sourceThreadId,
            providerSessionId: "session",
            providerInstanceId,
            issuedAt: 0,
            capabilities: new Set(["orchestration" as const]),
          }),
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: () => Effect.succeed(caller),
          }),
          Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
          Layer.mock(Project.ProjectService)({
            create: (input) =>
              Effect.sync(() => {
                registered.push(input.workspaceRoot);
                return {
                  ...createdProject,
                  id: input.projectId,
                  workspaceRoot: input.workspaceRoot,
                };
              }),
            getById: (projectId) =>
              Effect.succeed(
                projectId === createdProjectId ? Option.some(createdProject) : Option.none(),
              ),
          }),
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
            namedProjectsRoot: "/projects",
            createNamedProject: (input) =>
              Effect.sync(() => {
                named.push(input.name);
                return {
                  projectId: createdProjectId,
                  workspaceRoot: createdProject.workspaceRoot,
                  commitError: "Git has no name or email on this machine.",
                };
              }),
          }),
          NodeServices.layer,
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-named-project-" }).pipe(
            Layer.provide(NodeServices.layer),
          ),
        ),
      ),
    );
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(ProjectHandlersLive.pipe(Layer.provide(dependencies))),
    );
    const handle = (params: Parameters<typeof toolkit.handle<"t3_project_create">>[1]) =>
      toolkit
        .handle("t3_project_create", params)
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));

    const result = yield* handle({ title: "Pinball Stats" });
    expect(result.at(-1)?.result).toMatchObject({
      id: createdProjectId,
      workspaceRoot: "/projects/pinball-stats",
      commitError: "Git has no name or email on this machine.",
    });
    expect(named).toEqual(["Pinball Stats"]);

    // A path still registers that folder, and never makes a named project.
    yield* handle({ title: "Existing", workspaceRoot: "/work/existing" });
    expect(registered).toEqual(["/work/existing"]);

    // Fields this mode cannot apply are rejected, not dropped.
    for (const extra of [
      { scripts: [] },
      { defaultModelSelection: { instanceId: providerInstanceId, model: "gpt-5" } },
    ]) {
      const rejected = yield* handle({ title: "Configured", ...extra });
      expect(rejected.at(-1)?.result).toMatchObject({ code: "invalid_request" });
    }
    expect(named).toEqual(["Pinball Stats"]);
  }),
);

const settingsProjectId = ProjectId.make("project:settings");
const settingsModel = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };
const setupScript = {
  id: "setup",
  name: "Setup",
  command: "pnpm install",
  icon: "configure",
  runOnWorktreeCreate: true,
} satisfies ProjectScript;
const projectSettingsInput = {
  scripts: [setupScript],
  defaultModelSelection: settingsModel,
  defaultThreadEnvMode: "worktree" as const,
  autoPull: true,
};

const makeProjectSettingsHarness = Effect.fn("makeProjectSettingsHarness")(function* (
  settingsOverrides: Parameters<typeof Settings.layerTest>[0] = {},
) {
  let project: ProjectRecord = {
    id: settingsProjectId,
    title: "Settings project",
    workspaceRoot: "/work/settings",
    defaultModelSelection: null,
    defaultThreadEnvMode: null,
    autoPull: false,
    scripts: [],
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    deletedAt: null,
  };
  const updates: Project.ProjectUpdateInput[] = [];
  const creates: Project.ProjectCreateInput[] = [];
  const writes: ServerSettingsPatch[] = [];
  const settingsContext = yield* Layer.build(
    Settings.layerTest({ projectSettingsFolded: true, ...settingsOverrides }),
  );
  const settings = yield* Settings.ServerSettingsService.pipe(Effect.provide(settingsContext));
  const caller = {
    id: ThreadId.make("source-thread"),
    projectId: settingsProjectId,
    providerInstanceId: settingsModel.instanceId,
    runtimeMode: "full-access",
    interactionMode: "default",
    archivedAt: null,
    deletedAt: null,
    activeRunId: "active-run",
  } as OrchestrationV2ThreadShell;
  const layer = Layer.mergeAll(
    NodeCrypto.layer,
    Layer.succeed(Settings.ServerSettingsService, {
      ...settings,
      updateSettings: (patch) => {
        writes.push(patch);
        return settings.updateSettings(patch);
      },
    }),
    Layer.succeed(McpInvocationContext.McpInvocationContext, {
      environmentId: EnvironmentId.make("environment"),
      threadId: caller.id,
      providerSessionId: "session",
      providerInstanceId: settingsModel.instanceId,
      issuedAt: 0,
      capabilities: new Set(["orchestration" as const]),
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: () => Effect.succeed(caller),
    }),
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/projects" }),
    Layer.mock(Project.ProjectService)({
      update: (input) =>
        Effect.gen(function* () {
          updates.push(input);
          if (input.projectId !== project.id) {
            return yield* new Project.ProjectNotFoundError({ projectId: input.projectId });
          }
          const { commandId: _commandId, projectId: _projectId, ...fields } = input;
          project = {
            ...project,
            ...fields,
            title: fields.title ?? project.title,
            workspaceRoot: fields.workspaceRoot ?? project.workspaceRoot,
            defaultModelSelection:
              fields.defaultModelSelection === undefined
                ? project.defaultModelSelection
                : fields.defaultModelSelection,
            scripts: fields.scripts ?? project.scripts,
          };
          return project;
        }),
      create: (input) =>
        Effect.sync(() => {
          creates.push(input);
          project = {
            ...project,
            id: input.projectId,
            title: input.title,
            workspaceRoot: input.workspaceRoot,
            scripts: input.scripts ?? [],
          };
          return project;
        }),
      getById: (id) =>
        Effect.sync(() => (id === project.id ? Option.some(project) : Option.none())),
      snapshot: Effect.sync(() => ({ projects: [project], updatedAt: project.updatedAt })),
    }),
  );
  // handle provides dependencies on every call; retain one built settings instance.
  const dependencies = Layer.succeedContext(
    yield* Layer.build(ProjectSettingsService.layer.pipe(Layer.provideMerge(layer))),
  );
  const toolkit = yield* ProjectToolkit.pipe(
    Effect.provide(ProjectHandlersLive.pipe(Layer.provide(dependencies))),
  );
  const handle = <
    Name extends "t3_project_update" | "t3_project_read" | "t3_project_list" | "t3_project_create",
  >(
    name: Name,
    params: Parameters<typeof toolkit.handle<Name>>[1],
  ) =>
    toolkit.handle(name, params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map((results) => results.at(-1)?.result),
      Effect.provide(dependencies),
    );
  return { handle, settings, updates, creates, writes, getProject: () => project };
});

it.effect.each([true, false])(
  "saves project settings in overrides when projectSettingsFolded is %s",
  (projectSettingsFolded) =>
    Effect.gen(function* () {
      const harness = yield* makeProjectSettingsHarness({ projectSettingsFolded });
      const result = yield* harness.handle("t3_project_update", {
        projectId: settingsProjectId,
        title: "Updated title",
        ...projectSettingsInput,
      });
      const settings = yield* harness.settings.getSettings;
      expect(settings.projectSettingsOverrides[settingsProjectId]).toEqual({
        defaultProjectScripts: [setupScript],
        defaultModelSelection: settingsModel,
        defaultThreadEnvMode: "worktree",
        defaultAutoPull: true,
      });
      expect(harness.updates).toEqual([
        { projectId: settingsProjectId, title: "Updated title", commandId: expect.any(String) },
      ]);
      expect(resolveProjectScripts(settings, harness.getProject())).toEqual([setupScript]);
      expect(
        resolveProjectSettings(settings, settingsProjectId, harness.getProject()),
      ).toMatchObject({
        settings: {
          defaultModelSelection: settingsModel,
          defaultThreadEnvMode: "worktree",
          defaultAutoPull: true,
        },
        sources: { defaultModelSelection: "project", defaultThreadEnvMode: "project" },
      });
      expect(result).toMatchObject({ title: "Updated title", ...projectSettingsInput });
      expect(yield* harness.handle("t3_project_read", { projectId: settingsProjectId })).toEqual(
        result,
      );
      expect(yield* harness.handle("t3_project_list", {})).toEqual({
        projects: [result],
        nextCursor: null,
      });
    }),
);

it.effect("returns environment defaults without writing overrides for a metadata-only update", () =>
  Effect.gen(function* () {
    const harness = yield* makeProjectSettingsHarness({
      defaultProjectScripts: [setupScript],
      defaultModelSelection: settingsModel,
      defaultThreadEnvMode: "worktree",
      defaultAutoPull: true,
    });
    const result = yield* harness.handle("t3_project_update", {
      projectId: settingsProjectId,
      title: "Renamed",
    });
    expect(result).toMatchObject({ title: "Renamed", ...projectSettingsInput });
    expect(yield* harness.handle("t3_project_read", { projectId: settingsProjectId })).toEqual(
      result,
    );
    expect(yield* harness.handle("t3_project_list", {})).toEqual({
      projects: [result],
      nextCursor: null,
    });
    expect(harness.writes).toEqual([]);
    expect((yield* harness.settings.getSettings).projectSettingsOverrides).toEqual({});
  }),
);

it.effect(
  "clears model, env mode and scripts while preserving auto-pull and inheriting defaults",
  () =>
    Effect.gen(function* () {
      const environmentModel = { ...settingsModel, model: "gpt-5-mini" };
      const environmentScript = { ...setupScript, command: "npm install" };
      const harness = yield* makeProjectSettingsHarness({
        defaultModelSelection: environmentModel,
        defaultThreadEnvMode: "local",
        defaultProjectScripts: [environmentScript],
        projectSettingsOverrides: {
          [settingsProjectId]: {
            defaultModelSelection: settingsModel,
            defaultThreadEnvMode: "worktree",
            defaultProjectScripts: [setupScript],
            defaultAutoPull: true,
          },
        },
      });
      const result = yield* harness.handle("t3_project_update", {
        projectId: settingsProjectId,
        defaultModelSelection: null,
        defaultThreadEnvMode: null,
        scripts: [],
      });
      expect(
        (yield* harness.settings.getSettings).projectSettingsOverrides[settingsProjectId],
      ).toEqual({
        defaultAutoPull: true,
      });
      expect(result).toMatchObject({
        defaultModelSelection: environmentModel,
        defaultThreadEnvMode: "local",
        scripts: [environmentScript],
        autoPull: true,
      });
      expect(yield* harness.handle("t3_project_read", { projectId: settingsProjectId })).toEqual(
        result,
      );
      const disabled = yield* harness.handle("t3_project_update", {
        projectId: settingsProjectId,
        autoPull: false,
      });
      expect(
        (yield* harness.settings.getSettings).projectSettingsOverrides[settingsProjectId],
      ).toEqual({
        defaultAutoPull: false,
      });
      expect(disabled).toMatchObject({ autoPull: false });
    }),
);

it.effect("clears stale project record settings before the settings fold", () =>
  Effect.gen(function* () {
    const environmentModel = { ...settingsModel, model: "gpt-5-mini" };
    const environmentScript = { ...setupScript, command: "npm install" };
    const harness = yield* makeProjectSettingsHarness({
      projectSettingsFolded: false,
      defaultModelSelection: environmentModel,
      defaultThreadEnvMode: "local",
      defaultProjectScripts: [environmentScript],
      projectSettingsOverrides: {
        [settingsProjectId]: {
          defaultModelSelection: settingsModel,
          defaultThreadEnvMode: "worktree",
          defaultProjectScripts: [setupScript],
        },
      },
    });
    Object.assign(harness.getProject(), {
      defaultModelSelection: settingsModel,
      defaultThreadEnvMode: "worktree",
      scripts: [setupScript],
    });

    const result = yield* harness.handle("t3_project_update", {
      projectId: settingsProjectId,
      defaultModelSelection: null,
      defaultThreadEnvMode: null,
      scripts: [],
    });
    const settings = yield* harness.settings.getSettings;
    // The update mock replaces the record; resolve against its current copy.
    const project = harness.getProject();
    expect(settings.projectSettingsFolded).toBe(false);
    expect(settings.projectSettingsOverrides).not.toHaveProperty(settingsProjectId);
    expect(resolveProjectScripts(settings, project)).toEqual([environmentScript]);
    expect(resolveProjectSettings(settings, settingsProjectId, project)).toMatchObject({
      settings: {
        defaultModelSelection: environmentModel,
        defaultThreadEnvMode: "local",
      },
      sources: { defaultModelSelection: "environment", defaultThreadEnvMode: "environment" },
    });
    expect(harness.updates).toEqual([
      {
        projectId: settingsProjectId,
        commandId: expect.any(String),
        defaultModelSelection: null,
        defaultThreadEnvMode: null,
        scripts: [],
      },
    ]);
    expect(result).toMatchObject({
      defaultModelSelection: environmentModel,
      defaultThreadEnvMode: "local",
      scripts: [environmentScript],
    });
  }),
);

it.effect("writes null to remove an empty project settings entry", () =>
  Effect.gen(function* () {
    const harness = yield* makeProjectSettingsHarness({
      projectSettingsOverrides: { [settingsProjectId]: { defaultProjectScripts: [setupScript] } },
    });
    yield* harness.handle("t3_project_update", { projectId: settingsProjectId, scripts: [] });
    expect(harness.writes).toEqual([{ projectSettingsOverrides: { [settingsProjectId]: null } }]);
    expect((yield* harness.settings.getSettings).projectSettingsOverrides).not.toHaveProperty(
      settingsProjectId,
    );
  }),
);

it.effect("preserves unrelated keys in an existing project settings entry", () =>
  Effect.gen(function* () {
    const harness = yield* makeProjectSettingsHarness({
      projectSettingsOverrides: { [settingsProjectId]: { enableAgentBrowserAccess: false } },
    });
    yield* harness.handle("t3_project_update", {
      projectId: settingsProjectId,
      scripts: [setupScript],
    });
    expect(
      (yield* harness.settings.getSettings).projectSettingsOverrides[settingsProjectId],
    ).toEqual({
      enableAgentBrowserAccess: false,
      defaultProjectScripts: [setupScript],
    });
  }),
);

it.effect("creates a workspace project with scripts and model in its settings overrides", () =>
  Effect.gen(function* () {
    const harness = yield* makeProjectSettingsHarness();
    const result = yield* harness.handle("t3_project_create", {
      title: "Created",
      workspaceRoot: "/work/created",
      scripts: [setupScript],
      defaultModelSelection: settingsModel,
    });
    const projectId = harness.getProject().id;
    expect(harness.creates).toEqual([
      {
        projectId,
        commandId: expect.any(String),
        title: "Created",
        workspaceRoot: "/work/created",
      },
    ]);
    expect((yield* harness.settings.getSettings).projectSettingsOverrides[projectId]).toEqual({
      defaultProjectScripts: [setupScript],
      defaultModelSelection: settingsModel,
    });
    expect(result).toMatchObject({
      id: projectId,
      scripts: [setupScript],
      defaultModelSelection: settingsModel,
    });
    expect(yield* harness.handle("t3_project_read", { projectId })).toEqual(result);
  }),
);

it.effect("rejects an unknown project before writing settings overrides", () =>
  Effect.gen(function* () {
    const harness = yield* makeProjectSettingsHarness();
    const result = yield* harness.handle("t3_project_update", {
      projectId: ProjectId.make("project:missing"),
      ...projectSettingsInput,
    });
    expect(result).toMatchObject({ code: "invalid_request" });
    expect(harness.writes).toEqual([]);
    expect((yield* harness.settings.getSettings).projectSettingsOverrides).toEqual({});
  }),
);
