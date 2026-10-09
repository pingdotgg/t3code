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
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
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
import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../../../vcs/VcsProcess.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as ProjectHandlers from "./handlers.ts";
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
    const layerDependencies = Layer.mergeAll(
      NodeCrypto.layer,
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment"),
        requestNamespace: "session",
        thread: {
          threadId: sourceThreadId,
          providerSessionId: "session",
          providerInstanceId,
        },
        client: undefined,
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
      Layer.mock(ProjectSettingsService.ProjectSettingsService)({}),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/projects" }),
      Layer.mock(GitVcsDriver.GitVcsDriver)({}),
      NodeServices.layer,
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-source-link-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    );
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(
          Layer.provide(layerDependencies),
        ),
      ),
    );
    const result = yield* toolkit
      .handle("t3_thread_launch", { title: "Audit", message: "Review the change" })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(layerDependencies));
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
    const layerDependencies = Layer.mergeAll(
      NodeCrypto.layer,
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment"),
        requestNamespace: "session",
        thread: {
          threadId: sourceThreadId,
          providerSessionId: "session",
          providerInstanceId,
        },
        client: undefined,
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
      Layer.mock(ProjectSettingsService.ProjectSettingsService)({}),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/projects",
        ensureScratchProject: Effect.succeed({ projectId: scratchProjectId }),
      }),
      Layer.mock(GitVcsDriver.GitVcsDriver)({}),
      NodeServices.layer,
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-scratch-launch-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    );
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(
          Layer.provide(layerDependencies),
        ),
      ),
    );
    const handle = (params: Parameters<typeof toolkit.handle<"t3_thread_launch">>[1]) =>
      toolkit
        .handle("t3_thread_launch", params)
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(layerDependencies));

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
    const layerDependencies = Layer.mergeAll(
      NodeCrypto.layer,
      Settings.layerTest(),
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment"),
        requestNamespace: "session",
        thread: {
          threadId: sourceThreadId,
          providerSessionId: "session",
          providerInstanceId,
        },
        client: undefined,
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
            return { ...createdProject, id: input.projectId, workspaceRoot: input.workspaceRoot };
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
      Layer.mock(GitVcsDriver.GitVcsDriver)({}),
      NodeServices.layer,
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-named-project-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    ).pipe((layer) => ProjectSettingsService.layer.pipe(Layer.provideMerge(layer)));
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(
          Layer.provide(layerDependencies),
        ),
      ),
    );
    const handle = (params: Parameters<typeof toolkit.handle<"t3_project_create">>[1]) =>
      toolkit
        .handle("t3_project_create", params)
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(layerDependencies));

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
      requestNamespace: "session",
      thread: {
        threadId: caller.id,
        providerSessionId: "session",
        providerInstanceId: settingsModel.instanceId,
      },
      client: undefined,
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
    Effect.provide(
      McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
    ),
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

const clientLaunchHarness = (input: {
  readonly runtimeModeCeiling: "approval-required" | "auto-accept-edits" | "auto" | "full-access";
  readonly launched: Array<ThreadLaunch.ThreadLaunchInput>;
  readonly workspaceRoot?: string;
  /** The model on the project record; omitted means the harness's model. */
  readonly recordModelSelection?: ProjectRecord["defaultModelSelection"];
  readonly settings?: Parameters<typeof Settings.layerTest>[0];
}) => {
  const projectId = ProjectId.make("project:client-target");
  const modelSelection = {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    model: "claude-opus",
  };
  let project: ProjectRecord = {
    id: projectId,
    title: "Client target",
    workspaceRoot: input.workspaceRoot ?? "/projects/client-target",
    defaultModelSelection:
      input.recordModelSelection === undefined ? modelSelection : input.recordModelSelection,
    defaultThreadEnvMode: null,
    autoPull: false,
    scripts: [],
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    deletedAt: null,
  };
  const layerDependencies = Layer.mergeAll(
    NodeCrypto.layer,
    Layer.succeed(McpInvocationContext.McpInvocationContext, {
      environmentId: EnvironmentId.make("environment"),
      requestNamespace: "client:session-1",
      thread: undefined,
      client: {
        sessionId: "session-1",
        label: "Claude Code",
        access: input.runtimeModeCeiling,
      },
      issuedAt: 0,
      capabilities: new Set(["orchestration" as const]),
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({}),
    Layer.mock(ThreadLaunch.ThreadLaunchService)({
      launch: (launch) => {
        input.launched.push(launch);
        return Effect.succeed({
          threadId: launch.threadId,
          projection: {
            thread: {
              id: launch.threadId,
              projectId: launch.projectId,
              modelSelection: launch.modelSelection,
            },
            runs: [],
          },
          resumed: false,
        } as unknown as ThreadLaunch.ThreadLaunchResult);
      },
    }),
    Layer.mock(Project.ProjectService)({
      getById: (id) => Effect.succeed(id === projectId ? Option.some(project) : Option.none()),
      update: ({ commandId: _commandId, projectId: _projectId, ...fields }) =>
        Effect.sync(() => {
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
    }),
    Settings.layerTest(input.settings),
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/projects" }),
    NodeServices.layer,
  ).pipe(
    (layer) => ProjectSettingsService.layer.pipe(Layer.provideMerge(layer)),
    Layer.provideMerge(GitVcsDriver.layer),
    Layer.provideMerge(VcsProcess.layer),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-client-launch-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
  return { projectId, modelSelection, dependencies: layerDependencies };
};

it.effect("a client launches at its ceiling with the project's default model", () =>
  Effect.gen(function* () {
    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const { projectId, modelSelection, dependencies } = clientLaunchHarness({
      runtimeModeCeiling: "auto-accept-edits",
      launched,
    });
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    const handle = (params: Parameters<typeof toolkit.handle<"t3_thread_launch">>[1]) =>
      toolkit
        .handle("t3_thread_launch", params)
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));

    const result = yield* handle({ title: "Fix", projectId, message: "Fix the bug" });
    expect(result.at(-1)?.result).toMatchObject({ projectId, modelSelection });
    expect(launched[0]?.runtimeMode).toBe("auto-accept-edits");
    expect(launched[0]?.initialMessage?.senderThreadId).toBeUndefined();

    const escalated = yield* handle({ title: "Fix", projectId, runtimeMode: "full-access" });
    expect(escalated.at(-1)?.result).toMatchObject({ code: "runtime_mode_escalation_denied" });

    const untargeted = yield* handle({ title: "Fix" });
    expect(untargeted.at(-1)?.result).toMatchObject({ code: "target_required" });
    expect(launched).toHaveLength(1);
  }),
);

it.effect("a client launch without a model uses the default t3_project_update saved", () =>
  Effect.gen(function* () {
    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const harness = clientLaunchHarness({
      runtimeModeCeiling: "full-access",
      launched,
      recordModelSelection: null,
      settings: { projectSettingsFolded: true },
    });
    // handle provides dependencies on every call; keep one settings instance across calls.
    const dependencies = Layer.succeedContext(yield* Layer.build(harness.dependencies));
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    const launch = toolkit
      .handle("t3_thread_launch", { title: "Fix", projectId: harness.projectId })
      .pipe(
        Stream.unwrap,
        Stream.runCollect,
        Effect.map((results) => results.at(-1)?.result),
        Effect.provide(dependencies),
      );

    expect(yield* launch).toMatchObject({
      code: "invalid_request",
      message: expect.stringContaining("Pass modelSelection"),
    });
    const savedModel = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };
    yield* toolkit
      .handle("t3_project_update", {
        projectId: harness.projectId,
        defaultModelSelection: savedModel,
      })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    expect(yield* launch).toMatchObject({
      projectId: harness.projectId,
      modelSelection: savedModel,
    });
    expect(launched.map((entry) => entry.modelSelection)).toEqual([savedModel]);
  }).pipe(Effect.scoped),
);

it.effect("a launch binds only an existing checkout that is one of the project's worktrees", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-launch-worktree-" });
    const repo = path.join(root, "repo");
    const worktree = path.join(root, "feature");
    const outside = path.join(root, "outside");
    yield* fileSystem.makeDirectory(repo);
    yield* fileSystem.makeDirectory(outside);

    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const { projectId, dependencies } = clientLaunchHarness({
      runtimeModeCeiling: "auto",
      launched,
      workspaceRoot: repo,
    });
    const git = yield* GitVcsDriver.GitVcsDriver.pipe(Effect.provide(dependencies));
    for (const args of [
      ["init", "-b", "main"],
      ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"],
      ["worktree", "add", "-b", "feature", worktree],
    ]) {
      yield* git.execute({ operation: "test.setupRepo", cwd: repo, args });
    }
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    const launchInto = (worktreePath: string) =>
      toolkit
        .handle("t3_thread_launch", {
          title: "Fix",
          projectId,
          workspaceStrategy: { type: "existing_worktree", worktreePath },
        })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));

    expect((yield* launchInto(worktree)).at(-1)?.result).toMatchObject({ projectId });
    expect((yield* launchInto(repo)).at(-1)?.result).toMatchObject({ projectId });
    for (const elsewhere of [outside, path.join(worktree, "..", "outside"), "/"]) {
      expect((yield* launchInto(elsewhere)).at(-1)?.result).toMatchObject({
        code: "invalid_request",
      });
    }
    expect(launched.map((launch) => launch.workspaceStrategy)).toEqual([
      { type: "existing_worktree", worktreePath: worktree },
      { type: "existing_worktree", worktreePath: repo },
    ]);

    // A removed worktree stays listed as prunable until `git worktree prune`;
    // whatever directory is later made at its path is not one of the project's.
    yield* fileSystem.remove(worktree, { recursive: true });
    yield* fileSystem.makeDirectory(worktree);
    expect((yield* launchInto(worktree)).at(-1)?.result).toMatchObject({
      code: "invalid_request",
    });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
