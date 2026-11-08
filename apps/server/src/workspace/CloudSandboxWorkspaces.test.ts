import * as ServerConfig from "../config.ts";
import { expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  ProjectId,
  ManagedCloudSandboxResourceId,
  type Project,
  ProviderInstanceId,
  SandboxProfileId,
  ThreadId,
  WorktreeMcpFailure,
  NodeId,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import * as FileSystem from "effect/FileSystem";
import { HttpClient, HttpClientResponse } from "effect/http";
import { idleThreadProjection, liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Links from "../peer/PeerLinks.ts";
import * as Forwarding from "../peer/PeerForwarding.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";
import * as Delegation from "../peer/RemoteDelegation.ts";
import * as Git from "../git/GitWorkflowService.ts";
import * as GitDriver from "../vcs/GitVcsDriver.ts";
import * as Controller from "./CloudSandboxController.ts";
import * as Manager from "../cloudSandbox/CloudSandboxManager.ts";
import { CloudSandboxManagerError } from "../cloudSandbox/CloudSandboxStore.ts";
import * as Profiles from "../cloudSandbox/CloudSandboxProfiles.ts";
import { descriptorOf, layerLinkingEnvironment } from "../peer/PeerLinks.testkit.ts";
import * as Settings from "../serverSettings.ts";
import * as Setup from "../project/ProjectSetupScriptRunner.ts";
import * as ProjectTransfer from "./CloudSandboxProjectTransfer.ts";
import * as Workspaces from "./CloudSandboxWorkspaces.ts";
import type { McpThreadInvocationScope } from "../mcp/McpInvocationContext.ts";

const scope: McpThreadInvocationScope = {
  environmentId: EnvironmentId.make("source"),
  requestNamespace: "session",
  issuedAt: 1,
  thread: {
    threadId: ThreadId.make("owner"),
    providerSessionId: "session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  capabilities: new Set(["orchestration", "worktree"]),
  client: undefined,
};

it.effect.each([true, false])(
  "keeps failed deletion journaled and retries on either host (in sandbox: %s)",
  (inSandbox) => {
    let deletions = 0;
    const context = Layer.mergeAll(
      Sqlite.layerMemory,
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-sandbox-workspaces-" }),
      Layer.mock(Controller.CloudSandboxController)({
        available: Effect.succeed(inSandbox),
        request: () => {
          if (!inSandbox)
            return Effect.die("A root workspace must delete through its local manager.");
          deletions++;
          return deletions === 1
            ? Effect.fail(
                new WorktreeMcpFailure({
                  code: "operation_failed",
                  message: "controller unavailable",
                }),
              )
            : Effect.succeed({ _tag: "deleted" } as const);
        },
      }),
      Layer.mock(Setup.ProjectSetupScriptRunner)({}),
      Layer.mock(Threads.ThreadManagementService)({}),
      Layer.mock(Projects.ProjectService)({}),
      Layer.mock(Links.PeerLinks)({}),
      Layer.mock(Forwarding.PeerForwarding)({}),
      Layer.mock(Delegation.RemoteDelegation)({}),
      Layer.mock(Manager.CloudSandboxManager)({
        list: Effect.succeed([]),
        release: () => {
          deletions++;
          return deletions === 1
            ? Effect.fail(new CloudSandboxManagerError({ reason: "provider" }))
            : Effect.void;
        },
      }),
      Layer.mock(Profiles.CloudSandboxProfiles)({ list: Effect.succeed([]) }),
      Layer.mock(Git.GitWorkflowService)({}),
      Layer.mock(GitDriver.GitVcsDriver)({}),
    );
    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO cloud_sandbox_workspaces (workspace_id,source_thread_id,payload_json) VALUES
      ('owned','owner','{"workspaceId":"owned","sourceThreadId":"owner","requestJson":"{}","phase":"creating","result":null}'),
      ('foreign','another','{"workspaceId":"foreign","sourceThreadId":"another","requestJson":"{}","phase":"creating","result":null}')`;
      const workspaces = yield* Workspaces.CloudSandboxWorkspaces;
      const config = yield* ServerConfig.ServerConfig;
      expect((yield* workspaces.sharePreview(config.port).pipe(Effect.result))._tag).toBe(
        "Failure",
      );
      expect(deletions).toBe(0);
      const refused = yield* workspaces.remove(scope, "foreign").pipe(Effect.result);
      expect(refused._tag).toBe("Failure");
      expect(deletions).toBe(0);
      expect((yield* workspaces.remove(scope, "owned").pipe(Effect.result))._tag).toBe("Failure");
      const failed = yield* sql<{
        readonly payload_json: string;
      }>`SELECT payload_json FROM cloud_sandbox_workspaces WHERE workspace_id='owned'`;
      expect(failed[0]?.payload_json).toContain('"phase":"deleting"');
      expect(yield* workspaces.remove(scope, "owned")).toEqual({
        workspaceId: "owned",
        deleted: true,
      });
      expect(yield* workspaces.remove(scope, "owned")).toEqual({
        workspaceId: "owned",
        deleted: true,
      });
      expect(deletions).toBe(2);
      yield* sql`INSERT INTO cloud_sandbox_workspaces (workspace_id,source_thread_id,payload_json) VALUES
      ('cleanup','owner','{"workspaceId":"cleanup","sourceThreadId":"owner","requestJson":"{}","phase":"resource-deleted","result":null}')`;
      expect(yield* workspaces.remove(scope, "cleanup")).toEqual({
        workspaceId: "cleanup",
        deleted: true,
      });
      expect(deletions).toBe(2);
    }).pipe(
      Effect.provide(
        Workspaces.layer.pipe(Layer.provideMerge(context), Layer.provide(NodeServices.layer)),
      ),
      Effect.scoped,
    );
  },
);

it.effect.each([false, true])("runs child setup once across retries (failure: %s)", (fails) => {
  let starts = 0;
  const projectId = ProjectId.make("child-project");
  const project: Project = {
    id: projectId,
    title: "child",
    workspaceRoot: "/child/repo",
    scripts: [],
    repositoryIdentity: null,
    defaultModelSelection: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    deletedAt: null,
  };
  const context = Layer.mergeAll(
    Sqlite.layerMemory,
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-child-setup-" }),
    Layer.mock(Controller.CloudSandboxController)({ available: Effect.succeed(true) }),
    Layer.mock(Threads.ThreadManagementService)({
      getThreadRecords: () =>
        Effect.succeed({ thread: { projectId } } as unknown as Effect.Success<
          ReturnType<Threads.ThreadManagementService["Service"]["getThreadRecords"]>
        >),
    }),
    Layer.mock(Projects.ProjectService)({ getById: () => Effect.succeedSome(project) }),
    Layer.mock(Links.PeerLinks)({}),
    Layer.mock(Forwarding.PeerForwarding)({}),
    Layer.mock(Delegation.RemoteDelegation)({}),
    Layer.mock(Manager.CloudSandboxManager)({ list: Effect.succeed([]) }),
    Layer.mock(Profiles.CloudSandboxProfiles)({ list: Effect.succeed([]) }),
    Layer.mock(Git.GitWorkflowService)({}),
    Layer.mock(GitDriver.GitVcsDriver)({}),
    Layer.mock(Setup.ProjectSetupScriptRunner)({
      runForThread: (input) => {
        starts++;
        expect(input).toMatchObject({
          threadId: "child-thread",
          projectId,
          worktreePath: "/child/repo",
          observeCompletion: {},
        });
        return Effect.succeed({
          status: "started",
          scriptId: "setup",
          scriptName: "Setup",
          scriptCommand: "setup",
          terminalId: "setup",
          cwd: input.worktreePath,
          async: true,
          completion: Effect.succeed({ exitCode: fails ? 1 : 0, durationMs: 0 }),
        });
      },
    }),
  );
  return Effect.gen(function* () {
    const workspace = yield* Workspaces.CloudSandboxWorkspaces;
    const run = workspace.setupThread(projectId, ThreadId.make("child-thread")).pipe(Effect.result);
    expect((yield* run)._tag).toBe(fails ? "Failure" : "Success");
    expect((yield* run)._tag).toBe(fails ? "Failure" : "Success");
    expect(starts).toBe(1);
  }).pipe(
    Effect.provide(
      Workspaces.layer.pipe(Layer.provideMerge(context), Layer.provide(NodeServices.layer)),
    ),
    Effect.scoped,
  );
});

it.effect("checks the real source gate before allocation and propagates child consent", () => {
  const requests: unknown[] = [];
  const projectId = ProjectId.make("source-project");
  const context = Layer.mergeAll(
    Layer.mock(Controller.CloudSandboxController)({
      available: Effect.succeed(true),
      request: (input) => {
        requests.push(input);
        return Effect.fail(
          new WorktreeMcpFailure({
            code: "operation_failed",
            message: "allocation fixture stops here",
          }),
        );
      },
    }),
    Layer.mock(Threads.ThreadManagementService)({
      getThreadRecords: () =>
        Effect.succeed({ thread: { projectId, runtimeMode: "auto" } } as unknown as Effect.Success<
          ReturnType<Threads.ThreadManagementService["Service"]["getThreadRecords"]>
        >),
    }),
    Layer.mock(Projects.ProjectService)({
      getById: () =>
        Effect.succeedSome({
          id: projectId,
          title: "source",
          workspaceRoot: "/source/repo",
          scripts: [],
        } as unknown as Project),
    }),
    Layer.mock(Forwarding.PeerForwarding)({}),
    Layer.mock(Delegation.RemoteDelegation)({}),
    Layer.mock(Manager.CloudSandboxManager)({ list: Effect.succeed([]) }),
    Layer.mock(Profiles.CloudSandboxProfiles)({ list: Effect.succeed([]) }),
    Layer.mock(Git.GitWorkflowService)({}),
    Layer.mock(GitDriver.GitVcsDriver)({}),
    Layer.mock(Setup.ProjectSetupScriptRunner)({}),
  );
  return Effect.gen(function* () {
    const workspace = yield* Workspaces.CloudSandboxWorkspaces;
    const settings = yield* Settings.ServerSettingsService;
    const input = {
      branch: "child",
      isolation: {
        kind: "sandbox",
        operationId: ManagedCloudSandboxResourceId.make("owned-child"),
      },
    } as const;
    yield* settings.updateSettings({ linkedEnvironmentsEnabled: false });
    expect((yield* workspace.handoff(scope, input).pipe(Effect.result))._tag).toBe("Failure");
    expect(requests).toEqual([]);
    yield* settings.updateSettings({ linkedEnvironmentsEnabled: true });
    yield* workspace.handoff(scope, input).pipe(Effect.result);
    expect(requests).toEqual([
      { _tag: "fork", operationId: "owned-child", name: "child", enableLinkedEnvironments: true },
    ]);
  }).pipe(
    Effect.provide(
      Workspaces.layer.pipe(
        Layer.provideMerge(context),
        Layer.provideMerge(layerLinkingEnvironment(descriptorOf("source", "Source"))),
        Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-workspace-gate-" })),
        Layer.provide(NodeServices.layer),
      ),
    ),
    Effect.scoped,
  );
});

it.effect.each([
  {
    record: "running",
    threadLive: false,
    phase: "connected",
    state: "stopped",
    fails: false,
    attempts: 1,
    reclaimed: 1,
  },
  {
    record: "running",
    threadLive: false,
    phase: "failed",
    state: "ready",
    fails: false,
    attempts: 0,
    reclaimed: 0,
  },
  {
    record: "running",
    threadLive: false,
    phase: "stopped",
    state: "stopped",
    fails: true,
    attempts: 1,
    reclaimed: 0,
  },
  {
    record: "creating",
    threadLive: true,
    phase: "connected",
    state: "stopped",
    fails: false,
    attempts: 1,
    reclaimed: 1,
  },
  {
    record: "creating",
    threadLive: true,
    phase: "connected",
    state: "ready",
    fails: false,
    attempts: 0,
    reclaimed: 0,
  },
  {
    record: "running",
    threadLive: true,
    phase: "connected",
    state: "stopped",
    fails: false,
    attempts: 0,
    reclaimed: 0,
  },
  {
    record: "running",
    threadLive: true,
    phase: "deleted",
    state: "stopped",
    fails: false,
    attempts: 0,
    reclaimed: 1,
  },
] as const)("reclaims only stopped VMs after confirmed deletion (%s)", (scenario) => {
  const resource = {
    resourceId: ManagedCloudSandboxResourceId.make("owned"),
    controllerEnvironmentId: EnvironmentId.make("controller"),
    driverKind: "boat",
    profileId: SandboxProfileId.make("boat"),
    sandboxId: "sandbox",
    parentResourceId: null,
    phase: scenario.phase,
    environmentId: EnvironmentId.make("child"),
    label: "Child",
    recordingIds: [],
  } as const;
  let attempts = 0;
  let unlinks = 0;
  const dependencies = Layer.mergeAll(
    Sqlite.layerMemory,
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-workspace-sweep-" }),
    Layer.mock(Controller.CloudSandboxController)({ available: Effect.succeed(false) }),
    Layer.mock(Threads.ThreadManagementService)({
      getThreadShell: () =>
        Effect.succeed(scenario.threadLive ? liveThreadShell(ThreadId.make("owner")) : null),
    }),
    Layer.mock(Projects.ProjectService)({}),
    Layer.mock(Links.PeerLinks)({
      unlink: () =>
        Effect.sync(() => {
          unlinks++;
          return true;
        }),
    }),
    Layer.mock(Forwarding.PeerForwarding)({}),
    Layer.mock(Delegation.RemoteDelegation)({}),
    Layer.mock(Git.GitWorkflowService)({}),
    Layer.mock(GitDriver.GitVcsDriver)({}),
    Layer.mock(Setup.ProjectSetupScriptRunner)({}),
    Layer.mock(Profiles.CloudSandboxProfiles)({}),
    Layer.mock(Manager.CloudSandboxManager)({
      get: () => Effect.succeed(resource),
      resolve: () => Effect.succeedSome(resource),
      execute: () =>
        Effect.succeed({
          _tag: "status",
          sandbox: {
            sandboxId: "sandbox",
            driverKind: "boat",
            name: "Child",
            state: scenario.state,
            size: "small",
            autoStopDeadline: null,
            createdAt: "2026-01-01T00:00:00Z",
          },
          capabilities: {
            diskForking: false,
            desktopStreaming: false,
            autoStopKeepalive: false,
            publicPortHosting: false,
            hotResize: false,
            rootAccess: false,
          },
        }),
      release: () =>
        Effect.suspend(() => {
          attempts++;
          return scenario.fails
            ? Effect.fail(new CloudSandboxManagerError({ reason: "provider" }))
            : Effect.void;
        }),
    }),
  );
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const payload = JSON.stringify({
      workspaceId: "owned",
      sourceThreadId: "owner",
      requestJson: "{}",
      phase: scenario.record,
      childEnvironmentId: "child",
      result: null,
    });
    yield* sql`INSERT INTO cloud_sandbox_workspaces (workspace_id,source_thread_id,payload_json)
      VALUES ('owned','owner',${payload})`;
    const workspaces = yield* Workspaces.CloudSandboxWorkspaces;
    expect(yield* workspaces.sweep).toBe(scenario.reclaimed);
    expect(attempts).toBe(scenario.attempts);
    expect(unlinks).toBe(scenario.reclaimed);
    const rows = yield* sql<{
      payload_json: string;
    }>`SELECT payload_json FROM cloud_sandbox_workspaces WHERE workspace_id='owned'`;
    expect(rows[0]?.payload_json.includes('"phase":"deleted"')).toBe(scenario.reclaimed === 1);
  }).pipe(
    Effect.provide(
      Workspaces.layer.pipe(Layer.provideMerge(dependencies), Layer.provide(NodeServices.layer)),
    ),
    Effect.scoped,
  );
});

it.effect(
  "delegates through the controller's expanded route and preserves the requested execution settings",
  () => {
    const shell = liveThreadShell(scope.thread.threadId);
    const parent = idleThreadProjection(shell);
    const projectId = parent.thread.projectId;
    const project: Project = {
      id: projectId,
      title: "Source",
      workspaceRoot: "/source/repo",
      scripts: [],
      repositoryIdentity: null,
      defaultModelSelection: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      deletedAt: null,
    };
    const input = {
      task: "Inspect the checkout",
      branch: "sandbox/task",
      workspaceId: "workspace",
      modelSelection: {
        instanceId: ProviderInstanceId.make("other-codex"),
        model: "other-model",
        options: [{ id: "reasoningEffort", value: "low" }],
      },
      runtimeMode: "approval-required",
      interactionMode: "plan",
      runSetupScript: true,
    } as const;
    const connection = {
      sandboxId: "sandbox",
      driverKind: "boat",
      resourceId: "workspace",
      controllerEnvironmentId: "controller",
      environmentId: "child",
      label: "Child",
      routePrefix: "/api/cloud-sandboxes/managed/workspace/proxy",
      bearerToken: "fixture",
    };
    let receivedRoute: string | undefined;
    let receivedExecution:
      | Parameters<Delegation.RemoteDelegation["Service"]["delegateWorkspace"]>[1]
      | undefined;
    let controllerCalls = 0;
    const client = HttpClient.make((request) =>
      Effect.sync(() => {
        controllerCalls++;
        return HttpClientResponse.fromWeb(
          request,
          Response.json({ _tag: "connection", connection, pairingToken: "fresh" }),
        );
      }),
    );
    const peerCalls = Layer.mock(PeerMcpClient.PeerMcpClient)({
      call: ({ tool, success }) =>
        Schema.decodeEffect(Schema.fromJsonString(success))(
          JSON.stringify(
            tool === "t3_project_list"
              ? { projects: [], nextCursor: null }
              : tool === "t3_project_create"
                ? { ...project, id: "child-project" }
                : { branch: input.branch },
          ),
        ).pipe(
          Effect.mapError(
            () =>
              new OrchestratorMcpFailure({ code: "invalid_request", message: "fixture response" }),
          ),
        ),
    });
    const baseDependencies = Layer.mergeAll(
      Sqlite.layerMemory,
      Layer.mock(Threads.ThreadManagementService)({
        getThreadRecords: () => Effect.succeed(parent),
        getThreadShell: () => Effect.succeed(shell),
      }),
      Layer.mock(Projects.ProjectService)({ getById: () => Effect.succeedSome(project) }),
      Layer.mock(Links.PeerLinks)({
        enabled: Effect.succeed(true),
        get: () => Effect.succeedNone,
        link: (request) =>
          Effect.sync(() => {
            receivedRoute = request.url;
            return {
              environmentId: EnvironmentId.make("child"),
              label: "Child",
              urls: [request.url],
              access: "auto" as const,
              linkedAt: DateTime.makeUnsafe("2026-01-01T00:00:00Z"),
              expiresAt: DateTime.makeUnsafe("2026-02-01T00:00:00Z"),
              lastReachedAt: null,
              lastError: null,
            };
          }),
      }),
      Layer.mock(Delegation.RemoteDelegation)({
        delegateWorkspace: (_scope, request) =>
          Effect.sync(() => {
            receivedExecution = request;
            return {
              taskId: NodeId.make("task"),
              threadId: ThreadId.make("child-thread"),
              projectId: ProjectId.make("child-project"),
            };
          }),
      }),
      Layer.mock(Git.GitWorkflowService)({}),
      Layer.mock(GitDriver.GitVcsDriver)({}),
      Layer.mock(Setup.ProjectSetupScriptRunner)({}),
      Layer.mock(Profiles.CloudSandboxProfiles)({}),
      Layer.mock(Manager.CloudSandboxManager)({}),
    );
    const dependencies = Forwarding.layer.pipe(
      Layer.provideMerge(Layer.mergeAll(baseDependencies, peerCalls)),
    );
    return Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(
        `${config.baseDir}/managed-cloud.json`,
        JSON.stringify({
          resourceId: "source",
          controllerEnvironmentId: "controller",
          controllerBaseUrl: "http://127.0.0.1:47773",
          grantToken: "fixture",
        }),
      );
      return yield* Effect.gen(function* () {
        const workspaces = yield* Workspaces.CloudSandboxWorkspaces;
        const result = yield* workspaces.delegateSandboxTask(scope, input);
        expect(result.environmentId).toBe("child");
        expect(receivedRoute).toBe(
          "http://127.0.0.1:47773/api/cloud-sandboxes/managed/workspace/proxy",
        );
        expect(receivedExecution?.target).toMatchObject({
          providerInstanceId: input.modelSelection.instanceId,
          model: input.modelSelection.model,
          options: input.modelSelection.options,
        });
        expect(receivedExecution?.runtimeMode).toBe(input.runtimeMode);
        expect(receivedExecution?.interactionMode).toBe(input.interactionMode);
        expect(yield* workspaces.delegateSandboxTask(scope, input)).toEqual(result);
        expect(controllerCalls).toBe(1);
        const reused = yield* workspaces
          .delegateSandboxTask(scope, { ...input, task: "Inspect something else" })
          .pipe(Effect.flip);
        expect(reused.message).toContain("already belongs to another request");
        expect(controllerCalls).toBe(1);
      }).pipe(
        Effect.provide(
          Workspaces.layer.pipe(Layer.provideMerge(dependencies), Layer.provide(Controller.layer)),
        ),
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-expanded-controller-" }),
          Layer.succeed(HttpClient.HttpClient, client),
        ).pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
      ),
      Effect.scoped,
    );
  },
);

it.effect(
  "provisions root fleet sandboxes with linked environments, transfers the source checkout, and links via persisted runtime port",
  () => {
    const shell = liveThreadShell(scope.thread.threadId);
    const parent = idleThreadProjection(shell);
    const projectId = parent.thread.projectId;
    const project: Project = {
      id: projectId,
      title: "Source",
      workspaceRoot: "/source/repo",
      scripts: [],
      repositoryIdentity: null,
      defaultModelSelection: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      deletedAt: null,
    };
    const input = {
      task: "Implement feature",
      title: "Sandbox task",
      branch: "sandbox/root-task",
      workspaceId: "root-workspace",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      runSetupScript: false,
    } as const;
    let provisionedLinkedEnvironments: boolean | undefined;
    let transferredCwd: string | undefined;
    let linkedUrl: string | undefined;
    let linkedToken: string | undefined;
    let createdWorkspaceRoot: string | undefined;
    const peerCalls = Layer.mock(PeerMcpClient.PeerMcpClient)({
      call: ({ tool, arguments: args, success }) => {
        if (tool === "t3_project_create" && typeof args.workspaceRoot === "string") {
          createdWorkspaceRoot = args.workspaceRoot;
        }
        return Schema.decodeEffect(Schema.fromJsonString(success))(
          JSON.stringify(
            tool === "t3_project_list"
              ? { projects: [], nextCursor: null }
              : tool === "t3_project_create"
                ? { ...project, id: "child-project", workspaceRoot: String(args.workspaceRoot) }
                : { branch: input.branch },
          ),
        ).pipe(
          Effect.mapError(
            () =>
              new OrchestratorMcpFailure({ code: "invalid_request", message: "fixture response" }),
          ),
        );
      },
    });
    const baseDependencies = Layer.mergeAll(
      Sqlite.layerMemory,
      Layer.mock(Controller.CloudSandboxController)({ available: Effect.succeed(false) }),
      Layer.mock(Threads.ThreadManagementService)({
        getThreadRecords: () => Effect.succeed(parent),
        getThreadShell: () => Effect.succeed(shell),
      }),
      Layer.mock(Projects.ProjectService)({ getById: () => Effect.succeedSome(project) }),
      Layer.mock(Links.PeerLinks)({
        enabled: Effect.succeed(true),
        get: () => Effect.succeedNone,
        link: (request) =>
          Effect.sync(() => {
            linkedUrl = request.url;
            linkedToken = request.pairingCode;
            return {
              environmentId: EnvironmentId.make("child"),
              label: "Child",
              urls: [request.url],
              access: "auto" as const,
              linkedAt: DateTime.makeUnsafe("2026-01-01T00:00:00Z"),
              expiresAt: DateTime.makeUnsafe("2026-02-01T00:00:00Z"),
              lastReachedAt: null,
              lastError: null,
            };
          }),
      }),
      Layer.mock(Delegation.RemoteDelegation)({
        delegateWorkspace: () =>
          Effect.succeed({
            taskId: NodeId.make("task"),
            threadId: ThreadId.make("child-thread"),
            projectId: ProjectId.make("child-project"),
          }),
      }),
      Layer.mock(Git.GitWorkflowService)({}),
      Layer.mock(GitDriver.GitVcsDriver)({}),
      Layer.mock(Setup.ProjectSetupScriptRunner)({}),
      Layer.mock(Profiles.CloudSandboxProfiles)({
        list: Effect.succeed([
          {
            profile: {
              profileId: SandboxProfileId.make("boat"),
              name: "Boat",
              driverKind: "boat",
              apiKeySet: true,
              defaultSize: "small",
              autoStopMinutes: 60,
              template: null,
              monthlyBudgetUsd: 25,
              maxConcurrentSandboxes: 3,
            },
            spend: null,
          },
        ]),
      }),
      Layer.mock(Manager.CloudSandboxManager)({
        provision: (request) =>
          Effect.sync(() => {
            provisionedLinkedEnvironments = request.enableLinkedEnvironments;
            return {
              httpBaseUrl: "http://127.0.0.1:40100",
              pairingToken: "fresh-pairing-token",
              connection: {
                sandboxId: "sandbox",
                driverKind: "boat" as const,
                resourceId: ManagedCloudSandboxResourceId.make("root-workspace"),
                controllerEnvironmentId: EnvironmentId.make("controller"),
                environmentId: EnvironmentId.make("child"),
                label: "Child",
                routePrefix: "/api/cloud-sandboxes/managed/root-workspace/proxy",
                bearerToken: "transport-bearer",
              },
            };
          }),
      }),
      Layer.succeed(ProjectTransfer.CloudSandboxProjectTransfer, {
        transfer: ({ cwd }) =>
          Effect.sync(() => {
            transferredCwd = cwd;
            return "/home/sandbox/.t3/cloud-workspaces/root-workspace/repo";
          }),
      }),
    );
    const dependencies = Forwarding.layer.pipe(
      Layer.provideMerge(Layer.mergeAll(baseDependencies, peerCalls)),
    );
    return Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(
        config.serverRuntimeStatePath,
        JSON.stringify({
          version: 1,
          pid: process.pid,
          port: 43123,
          origin: "http://127.0.0.1:43123",
          startedAt: "2026-01-01T00:00:00.000Z",
        }),
      );
      return yield* Effect.gen(function* () {
        const workspaces = yield* Workspaces.CloudSandboxWorkspaces;
        const result = yield* workspaces.delegateSandboxTask(scope, input);
        expect(provisionedLinkedEnvironments).toBe(true);
        expect(transferredCwd).toBe("/source/repo");
        expect(linkedUrl).toBe(
          "http://127.0.0.1:43123/api/cloud-sandboxes/managed/root-workspace/proxy",
        );
        expect(linkedToken).toBe("fresh-pairing-token");
        expect(createdWorkspaceRoot).toBe("/home/sandbox/.t3/cloud-workspaces/root-workspace/repo");
        expect(result.workspacePath).toBe("/home/sandbox/.t3/cloud-workspaces/root-workspace/repo");
      }).pipe(
        Effect.provide(
          Layer.effect(Workspaces.CloudSandboxWorkspaces, Workspaces.make).pipe(
            Layer.provideMerge(dependencies),
          ),
        ),
      );
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-root-fleet-" }).pipe(
          Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        ),
      ),
      Effect.scoped,
    );
  },
);

it.effect(
  "keeps setupThread receipts out of workspace reclamation and isolates per-record sweep failures",
  () => {
    const childThreadId = ThreadId.make("thread:child-setup");
    const childShell = liveThreadShell(childThreadId);
    const childProjection = idleThreadProjection(childShell);
    const project: Project = {
      id: childProjection.thread.projectId,
      title: "Child project",
      workspaceRoot: "/workspace/repo",
      scripts: [
        {
          id: "setup",
          name: "Setup",
          command: "bun install",
          icon: "play",
          runOnWorktreeCreate: true,
        },
      ],
      repositoryIdentity: null,
      defaultModelSelection: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      deletedAt: null,
    };
    const healthyResource = {
      resourceId: ManagedCloudSandboxResourceId.make("owned-healthy"),
      controllerEnvironmentId: EnvironmentId.make("controller"),
      driverKind: "boat" as const,
      profileId: SandboxProfileId.make("boat"),
      sandboxId: "sandbox-healthy",
      parentResourceId: null,
      phase: "connected" as const,
      environmentId: EnvironmentId.make("child-healthy"),
      label: "Healthy Child",
      recordingIds: [],
    };
    const brokenResource = {
      ...healthyResource,
      resourceId: ManagedCloudSandboxResourceId.make("owned-broken"),
      sandboxId: "sandbox-broken",
      environmentId: EnvironmentId.make("child-broken"),
    };
    let inSandbox = true;
    let setupRuns = 0;
    const released: string[] = [];
    const unlinked: string[] = [];
    const dependencies = Layer.mergeAll(
      Sqlite.layerMemory,
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-workspace-setup-sweep-" }),
      Layer.mock(Controller.CloudSandboxController)({
        available: Effect.sync(() => inSandbox),
      }),
      Layer.mock(Threads.ThreadManagementService)({
        getThreadRecords: (id) =>
          id === childThreadId
            ? Effect.succeed(childProjection)
            : Effect.fail(new Error(`unexpected thread ${id}`) as never),
        getThreadShell: () => Effect.succeed(null),
      }),
      Layer.mock(Projects.ProjectService)({
        getById: (id) => (id === project.id ? Effect.succeedSome(project) : Effect.succeedNone),
      }),
      Layer.mock(Links.PeerLinks)({
        unlink: (envId) =>
          envId === brokenResource.environmentId
            ? Effect.fail(new Error("unlink failed") as never)
            : Effect.sync(() => {
                unlinked.push(envId);
                return true;
              }),
      }),
      Layer.mock(Forwarding.PeerForwarding)({}),
      Layer.mock(Delegation.RemoteDelegation)({}),
      Layer.mock(Git.GitWorkflowService)({}),
      Layer.mock(GitDriver.GitVcsDriver)({}),
      Layer.mock(Setup.ProjectSetupScriptRunner)({
        runForThread: (input) =>
          Effect.sync(() => {
            setupRuns++;
            return {
              status: "started" as const,
              scriptId: "setup",
              scriptName: "Setup",
              scriptCommand: "bun install",
              terminalId: "term-1",
              cwd: input.worktreePath,
              async: true,
              completion: Effect.succeed({ exitCode: 0, durationMs: 0 }),
            };
          }),
      }),
      Layer.mock(Profiles.CloudSandboxProfiles)({}),
      Layer.mock(Manager.CloudSandboxManager)({
        get: (id) =>
          id === healthyResource.resourceId
            ? Effect.succeed(healthyResource)
            : id === brokenResource.resourceId
              ? Effect.succeed(brokenResource)
              : Effect.fail(new CloudSandboxManagerError({ reason: "not-found" })),
        resolve: () => Effect.succeedNone,
        execute: (resourceId) =>
          Effect.succeed({
            _tag: "status" as const,
            sandbox: {
              sandboxId: resourceId,
              driverKind: "boat" as const,
              name: resourceId,
              state: "stopped" as const,
              size: "small" as const,
              autoStopDeadline: null,
              createdAt: "2026-01-01T00:00:00Z",
            },
            capabilities: {
              diskForking: false,
              desktopStreaming: false,
              autoStopKeepalive: false,
              publicPortHosting: false,
              hotResize: false,
              rootAccess: false,
            },
          }),
        release: (id) =>
          Effect.sync(() => {
            released.push(id);
          }),
      }),
    );

    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const workspaces = yield* Workspaces.CloudSandboxWorkspaces;

      yield* workspaces.setupThread(project.id, childThreadId);
      yield* workspaces.setupThread(project.id, childThreadId);
      expect(setupRuns).toBe(1);

      yield* sql`INSERT INTO cloud_sandbox_workspaces (workspace_id,source_thread_id,payload_json)
        VALUES ('corrupt:id','owner','{"workspaceId":"corrupt:id","sourceThreadId":"owner","requestJson":"{}","phase":"running","childEnvironmentId":"child-corrupt","result":null}')`;
      yield* sql`INSERT INTO cloud_sandbox_workspaces (workspace_id,source_thread_id,payload_json)
        VALUES ('owned-broken','owner','{"workspaceId":"owned-broken","sourceThreadId":"owner","requestJson":"{}","phase":"running","childEnvironmentId":"child-broken","result":null}')`;
      yield* sql`INSERT INTO cloud_sandbox_workspaces (workspace_id,source_thread_id,payload_json)
        VALUES ('owned-healthy','owner','{"workspaceId":"owned-healthy","sourceThreadId":"owner","requestJson":"{}","phase":"running","childEnvironmentId":"child-healthy","result":null}')`;

      inSandbox = false;
      expect(yield* workspaces.sweep).toBe(1);
      expect(released).toEqual(["owned-broken", "owned-healthy"]);
      expect(unlinked).toEqual(["child-healthy"]);
    }).pipe(
      Effect.provide(
        Workspaces.layer.pipe(Layer.provideMerge(dependencies), Layer.provide(NodeServices.layer)),
      ),
      Effect.scoped,
    );
  },
);

const rootInput = {
  task: "Implement feature",
  title: "Sandbox task",
  branch: "sandbox/root-task",
  workspaceId: "root-workspace",
  modelSelection: {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.4",
  },
  runtimeMode: "full-access",
  interactionMode: "default",
  runSetupScript: false,
} as const;

const writeControllerPort = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  yield* fs.writeFileString(
    config.serverRuntimeStatePath,
    JSON.stringify({
      version: 1,
      pid: process.pid,
      port: 43123,
      origin: "http://127.0.0.1:43123",
      startedAt: "2026-01-01T00:00:00.000Z",
    }),
  );
});

/**
 * A root server that provisions a profile sandbox per workspace id. Its child
 * refuses interrupts the way a dead proxy does; every provision, release and
 * interrupt is counted.
 */
const rootFleetWorkspaces = (counts: {
  provisions: number;
  releases: number;
  interrupts: number;
}) => {
  const shell = liveThreadShell(scope.thread.threadId);
  const parent = idleThreadProjection(shell);
  const project: Project = {
    id: parent.thread.projectId,
    title: "Source",
    workspaceRoot: "/source/repo",
    scripts: [],
    repositoryIdentity: null,
    defaultModelSelection: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    deletedAt: null,
  };
  const peerCalls = Layer.mock(PeerMcpClient.PeerMcpClient)({
    call: ({ tool, arguments: args, success }) => {
      if (tool === "t3_thread_interrupt") {
        return Effect.suspend(() => {
          counts.interrupts++;
          return Effect.fail(
            new OrchestratorMcpFailure({ code: "thread_not_found", message: "The child is gone." }),
          );
        });
      }
      return Schema.decodeEffect(Schema.fromJsonString(success))(
        JSON.stringify(
          tool === "t3_project_list"
            ? { projects: [], nextCursor: null }
            : tool === "t3_project_create"
              ? { ...project, id: "child-project", workspaceRoot: String(args.workspaceRoot) }
              : { branch: rootInput.branch },
        ),
      ).pipe(
        Effect.mapError(
          () =>
            new OrchestratorMcpFailure({ code: "invalid_request", message: "fixture response" }),
        ),
      );
    },
  });
  const baseDependencies = Layer.mergeAll(
    Sqlite.layerMemory,
    Layer.mock(Controller.CloudSandboxController)({ available: Effect.succeed(false) }),
    Layer.mock(Threads.ThreadManagementService)({
      getThreadRecords: () => Effect.succeed(parent),
      getThreadShell: () => Effect.succeed(shell),
    }),
    Layer.mock(Projects.ProjectService)({ getById: () => Effect.succeedSome(project) }),
    Layer.mock(Links.PeerLinks)({
      enabled: Effect.succeed(true),
      get: () => Effect.succeedNone,
      link: (request) =>
        Effect.succeed({
          environmentId: EnvironmentId.make("child"),
          label: "Child",
          urls: [request.url],
          access: "auto" as const,
          linkedAt: DateTime.makeUnsafe("2026-01-01T00:00:00Z"),
          expiresAt: DateTime.makeUnsafe("2026-02-01T00:00:00Z"),
          lastReachedAt: null,
          lastError: null,
        }),
      unlink: () => Effect.succeed(true),
    }),
    Layer.mock(Delegation.RemoteDelegation)({
      delegateWorkspace: () =>
        Effect.succeed({
          taskId: NodeId.make("task"),
          threadId: ThreadId.make("child-thread"),
          projectId: ProjectId.make("child-project"),
        }),
    }),
    Layer.mock(Git.GitWorkflowService)({}),
    Layer.mock(GitDriver.GitVcsDriver)({}),
    Layer.mock(Setup.ProjectSetupScriptRunner)({}),
    Layer.mock(Profiles.CloudSandboxProfiles)({
      list: Effect.succeed([
        {
          profile: {
            profileId: SandboxProfileId.make("boat"),
            name: "Boat",
            driverKind: "boat",
            apiKeySet: true,
            defaultSize: "small",
            autoStopMinutes: 60,
            template: null,
            monthlyBudgetUsd: 25,
            maxConcurrentSandboxes: 3,
          },
          spend: null,
        },
      ]),
    }),
    Layer.mock(Manager.CloudSandboxManager)({
      provision: () =>
        Effect.sync(() => {
          counts.provisions++;
          return {
            httpBaseUrl: "http://127.0.0.1:40100",
            pairingToken: "fresh-pairing-token",
            connection: {
              sandboxId: "sandbox",
              driverKind: "boat" as const,
              resourceId: ManagedCloudSandboxResourceId.make("root-workspace"),
              controllerEnvironmentId: EnvironmentId.make("controller"),
              environmentId: EnvironmentId.make("child"),
              label: "Child",
              routePrefix: "/api/cloud-sandboxes/managed/root-workspace/proxy",
              bearerToken: "transport-bearer",
            },
          };
        }),
      release: () =>
        Effect.sync(() => {
          counts.releases++;
        }),
    }),
    Layer.succeed(ProjectTransfer.CloudSandboxProjectTransfer, {
      transfer: () => Effect.succeed("/home/sandbox/.t3/cloud-workspaces/root-workspace/repo"),
    }),
  );
  return Layer.effect(Workspaces.CloudSandboxWorkspaces, Workspaces.make).pipe(
    Layer.provideMerge(
      Forwarding.layer.pipe(Layer.provideMerge(Layer.mergeAll(baseDependencies, peerCalls))),
    ),
  );
};

it.effect("remove still deletes a root sandbox whose child refuses the interrupt", () => {
  const counts = { provisions: 0, releases: 0, interrupts: 0 };
  return Effect.gen(function* () {
    yield* writeControllerPort;
    const workspaces = yield* Workspaces.CloudSandboxWorkspaces;
    yield* workspaces.delegateSandboxTask(scope, rootInput);
    expect(yield* workspaces.remove(scope, rootInput.workspaceId)).toEqual({
      workspaceId: rootInput.workspaceId,
      deleted: true,
    });
    expect(counts.interrupts).toBe(1);
    expect(counts.releases).toBe(1);
  }).pipe(
    Effect.provide(
      rootFleetWorkspaces(counts).pipe(
        Layer.provideMerge(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-root-remove-interrupt-" }).pipe(
            Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
          ),
        ),
      ),
    ),
    Effect.scoped,
  );
});

it.effect(
  "a retry after its root sandbox was removed fails instead of returning the stored result",
  () => {
    const counts = { provisions: 0, releases: 0, interrupts: 0 };
    return Effect.gen(function* () {
      yield* writeControllerPort;
      const workspaces = yield* Workspaces.CloudSandboxWorkspaces;
      yield* workspaces.delegateSandboxTask(scope, rootInput);
      yield* workspaces.remove(scope, rootInput.workspaceId);
      const retry = yield* workspaces.delegateSandboxTask(scope, rootInput).pipe(Effect.flip);
      expect(retry.message).toContain("has been deleted");
      expect(counts.provisions).toBe(1);
    }).pipe(
      Effect.provide(
        rootFleetWorkspaces(counts).pipe(
          Layer.provideMerge(
            ServerConfig.layerTest(process.cwd(), { prefix: "t3-root-retry-deleted-" }).pipe(
              Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
            ),
          ),
        ),
      ),
      Effect.scoped,
    );
  },
);

it.effect("repoints live children's links to this server's port and skips the rest", () => {
  const repoints: Array<readonly [string, string]> = [];
  const dependencies = Layer.mergeAll(
    Sqlite.layerMemory,
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-workspace-repoint-" }),
    Layer.mock(Controller.CloudSandboxController)({ available: Effect.succeed(false) }),
    Layer.mock(Threads.ThreadManagementService)({}),
    Layer.mock(Projects.ProjectService)({}),
    Layer.mock(Links.PeerLinks)({
      repoint: (environmentId, url) =>
        environmentId === EnvironmentId.make("child-broken")
          ? Effect.fail(new Error("repoint failed") as never)
          : Effect.sync(() => {
              repoints.push([environmentId, url]);
            }),
    }),
    Layer.mock(Forwarding.PeerForwarding)({}),
    Layer.mock(Delegation.RemoteDelegation)({}),
    Layer.mock(Git.GitWorkflowService)({}),
    Layer.mock(GitDriver.GitVcsDriver)({}),
    Layer.mock(Setup.ProjectSetupScriptRunner)({}),
    Layer.mock(Profiles.CloudSandboxProfiles)({}),
    Layer.mock(Manager.CloudSandboxManager)({}),
  );
  return Effect.gen(function* () {
    yield* writeControllerPort;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO cloud_sandbox_workspaces (workspace_id,source_thread_id,payload_json) VALUES
      ('owned','owner','{"workspaceId":"owned","sourceThreadId":"owner","requestJson":"{}","phase":"running","childEnvironmentId":"child","result":null}'),
      ('owned-broken','owner','{"workspaceId":"owned-broken","sourceThreadId":"owner","requestJson":"{}","phase":"running","childEnvironmentId":"child-broken","result":null}'),
      ('retired','owner','{"workspaceId":"retired","sourceThreadId":"owner","requestJson":"{}","phase":"deleted","childEnvironmentId":"child-retired","result":null}'),
      ('no-child','owner','{"workspaceId":"no-child","sourceThreadId":"owner","requestJson":"{}","phase":"creating","result":null}')`;
    const workspaces = yield* Workspaces.CloudSandboxWorkspaces;
    expect(yield* workspaces.repointLinks).toBe(1);
    expect(repoints).toEqual([
      ["child", "http://127.0.0.1:43123/api/cloud-sandboxes/managed/owned/proxy"],
    ]);
  }).pipe(
    Effect.provide(
      Workspaces.layer.pipe(
        Layer.provideMerge(dependencies),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
    Effect.scoped,
  );
});
