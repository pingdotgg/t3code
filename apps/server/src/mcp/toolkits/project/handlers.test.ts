import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type HomeSettings,
  isHomeLaunchedThreadId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type Project as ProjectRecord,
} from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as ThreadLaunch from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ServerConfig from "../../../config.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as FleetBroker from "../../../home/FleetBroker.ts";
import * as FleetService from "../../../home/FleetService.ts";
import * as HomeService from "../../../home/HomeService.ts";
import { notHomeLayer } from "../../../home/HomeTestkit.ts";
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
      notHomeLayer,
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
              thread: { id: input.threadId, projectId, modelSelection, title: input.title },
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
    expect(result.at(-1)?.result).toMatchObject({
      projectId,
      modelSelection,
      link: expect.stringMatching(/^\[Audit\]\(t3-thread:\/\/v1\/environment\//),
    });
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
      notHomeLayer,
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
              thread: {
                id: input.threadId,
                projectId: input.projectId,
                modelSelection,
                title: input.title,
              },
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

it.effect("makes Home name a project and watches the thread before launching it", () =>
  Effect.gen(function* () {
    const homeThreadId = ThreadId.make("home:current");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const caller = {
      id: homeThreadId,
      projectId: ProjectId.make("project:home"),
      providerInstanceId,
      modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      activeRunId: "active-run",
      archivedAt: null,
      deletedAt: null,
    } as OrchestrationV2ThreadShell;
    const steps: Array<string> = [];
    const launched: Array<unknown> = [];
    let home = { threadId: homeThreadId, watchAll: false, watches: [] } as HomeSettings;
    const dependencies = Layer.mergeAll(
      NodeCrypto.layer,
      Layer.mock(HomeService.HomeService)({
        available: true,
        isHome: () => Effect.succeed(true),
        updateWatches: (_homeThreadId, update) => {
          home = update(home);
          steps.push(`watch ${home.watches.map((watch) => watch.threadId).join()}`);
          return Effect.succeed(home);
        },
      }),
      Layer.mock(FleetService.FleetService)({
        execute: ({ request }) => {
          if (request.op !== "threads.launch") return Effect.die("Unexpected operation.");
          steps.push(`launch ${request.input.threadId}`);
          return Effect.succeed({
            threadId: request.input.threadId!,
            link: `[${request.input.title}](t3-thread://v1/environment/${request.input.threadId})`,
            projectId: request.input.projectId!,
            modelSelection: caller.modelSelection,
            runId: null,
            status: null,
          });
        },
      }),
      Layer.mock(FleetBroker.FleetBroker)({}),
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment"),
        requestNamespace: "session",
        thread: { threadId: homeThreadId, providerSessionId: "session", providerInstanceId },
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
          return Effect.die("Home launched without a project.");
        },
      }),
      Layer.mock(Project.ProjectService)({
        getById: (projectId) =>
          Effect.succeed(
            Option.some({
              id: projectId,
              workspaceRoot: projectId === caller.projectId ? "/data/home" : "/code/app",
            } as never),
          ),
      }),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/projects",
        isInHomeFolder: (candidate) => Effect.succeed(candidate.startsWith("/data/home")),
      }),
      NodeServices.layer,
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-home-launch-" }).pipe(
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

    const unnamed = yield* handle({ title: "Audit", message: "Review the change" });
    expect(unnamed.at(-1)?.result).toMatchObject({ code: "invalid_request" });
    const own = yield* handle({ title: "Audit", projectId: caller.projectId });
    expect(own.at(-1)?.result).toMatchObject({ code: "invalid_request" });
    expect(steps).toEqual([]);

    // The watch is saved before the launch, under the id the launch then uses.
    const result = yield* handle({ title: "Audit", projectId: ProjectId.make("project:app") });
    const { threadId } = result.at(-1)!.result as { threadId: string };
    expect(isHomeLaunchedThreadId(threadId)).toBe(true);
    expect(steps).toEqual([`watch ${threadId}`, `launch ${threadId}`]);
    expect(launched).toHaveLength(0);

    // Home archives and settles; it never deletes.
    const deleted = yield* toolkit
      .handle("t3_project_delete", { projectId: ProjectId.make("project:app"), force: true })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    expect(deleted.at(-1)?.result).toMatchObject({ code: "capability_denied" });
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
    const dependencies = Layer.mergeAll(
      NodeCrypto.layer,
      notHomeLayer,
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
      NodeServices.layer,
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-named-project-" }).pipe(
        Layer.provide(NodeServices.layer),
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

const clientLaunchHarness = (input: {
  readonly runtimeModeCeiling: "approval-required" | "auto-accept-edits" | "auto" | "full-access";
  readonly launched: Array<ThreadLaunch.ThreadLaunchInput>;
}) => {
  const projectId = ProjectId.make("project:client-target");
  const modelSelection = { instanceId: ProviderInstanceId.make("claude"), model: "claude-opus" };
  const dependencies = Layer.mergeAll(
    NodeCrypto.layer,
    notHomeLayer,
    Layer.succeed(McpInvocationContext.McpInvocationContext, {
      environmentId: EnvironmentId.make("environment"),
      requestNamespace: "client:session-1",
      thread: undefined,
      client: {
        sessionId: "session-1",
        label: "Claude Code",
        runtimeModeCeiling: input.runtimeModeCeiling,
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
              title: launch.title,
            },
            runs: [],
          },
          resumed: false,
        } as unknown as ThreadLaunch.ThreadLaunchResult);
      },
    }),
    Layer.mock(Project.ProjectService)({
      getById: (id) =>
        Effect.succeed(
          id === projectId
            ? Option.some({ id, defaultModelSelection: modelSelection } as unknown as ProjectRecord)
            : Option.none(),
        ),
    }),
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/projects" }),
    NodeServices.layer,
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-client-launch-" }).pipe(
      Layer.provide(NodeServices.layer),
    ),
  );
  return { projectId, modelSelection, dependencies };
};

it.effect("a client launches at its ceiling with the project's default model", () =>
  Effect.gen(function* () {
    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const { projectId, modelSelection, dependencies } = clientLaunchHarness({
      runtimeModeCeiling: "auto-accept-edits",
      launched,
    });
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(ProjectHandlersLive.pipe(Layer.provide(dependencies))),
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
