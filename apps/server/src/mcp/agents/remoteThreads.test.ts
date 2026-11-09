import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import type { GatewayRuntimePort } from "@t3tools/client-runtime/gateway";
import {
  EnvironmentId,
  type OrchestrationV2RunStatus,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/ai";

import * as ServerConfig from "../../config.ts";
import * as DocumentText from "../../provider/DocumentText.ts";
import * as PeerForwarding from "../../peer/PeerForwarding.ts";
import * as PeerLinkRequests from "../../peer/PeerLinkRequests.ts";
import * as PeerLinks from "../../peer/PeerLinks.ts";
import * as TailnetDevices from "../../peer/TailnetDevices.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ManagedProjectFolders from "../../project/ManagedProjectFolders.ts";
import * as Project from "../../project/ProjectService.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as SourceControlRepositoryService from "../../sourceControl/SourceControlRepositoryService.ts";
import * as ThreadTaskService from "../../threadTask/ThreadTaskService.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as McpGatewayBrokerModule from "../McpGatewayBroker.ts";
import { McpGatewayBroker } from "../McpGatewayBroker.ts";
import {
  layerAgentsToolkit,
  layerInProcessMcpServer,
  toolkitRegistration,
} from "../McpHttpServer.ts";
import * as McpInvocationContext from "../McpInvocationContext.ts";
import * as McpToolAccess from "../McpToolAccess.ts";
import * as OrchestratorMcpService from "../OrchestratorMcpService.ts";
import * as ThreadMetadataMcpService from "../ThreadMetadataMcpService.ts";
import * as OrchestratorHandlers from "../toolkits/orchestrator/handlers.ts";
import { OrchestratorToolkit } from "../toolkits/orchestrator/tools.ts";
import * as ProjectHandlers from "../toolkits/project/handlers.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as ProjectCloneTracker from "../../project/ProjectCloneTracker.ts";
import { ProjectToolkit } from "../toolkits/project/tools.ts";
import { LocalGatewayPort } from "./LocalGatewayPort.ts";

// The 2026-10-22 shape: Captain on dev-box launching Cody on the MacBook.
const devBox = EnvironmentId.make("environment-dev-box");
const macBook = EnvironmentId.make("2549ba75-2a91-4554-8baa-88e6ae0efa48");
const captain = ThreadId.make("captain");
const child = ThreadId.make("mcp-thread-v2-macbook-child");
/** A thread the MacBook does not have: its snapshot fails and its thread list leaves it out. */
const missing = ThreadId.make("77647f60-dd5b-4d53-b383-9deb47912b88");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5" };

const callerShell = {
  id: captain,
  projectId: ProjectId.make("project:dev-box"),
  providerInstanceId: instanceId,
  modelSelection,
  runtimeMode: "full-access",
  interactionMode: "default",
  activeRunId: "run-captain",
  archivedAt: null,
  deletedAt: null,
} as OrchestrationV2ThreadShell;

/** The MacBook as the relaying desktop app reports it, and every call that reached it. */
const makeMacBook = (
  runStatuses: ReadonlyArray<OrchestrationV2RunStatus> = ["running"],
  /** The child's runs at each successive read; the last one repeats. Overrides runStatuses. */
  runsPerRead?: ReadonlyArray<
    ReadonlyArray<{ readonly id: string; readonly status: OrchestrationV2RunStatus }>
  >,
) => {
  const statuses = [...runStatuses];
  const reads = [...(runsPerRead ?? [])];
  const runs = () =>
    (reads.length > 1 ? reads.shift()! : reads[0])?.map((run) => ({
      ...run,
      providerInstanceId: instanceId,
      requestedAt: "2026-10-22T03:40:00.000Z",
      completedAt: null,
    }));
  const calls: Array<{ readonly method: string; readonly args: ReadonlyArray<unknown> }> = [];
  const thread = (threadId: string) => ({
    id: threadId,
    projectId: "project:macbook",
    title: "Configure Accessibility",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    parentThreadId: captain,
    parentEnvironmentId: devBox,
    profileSnapshot: { profileId: "cody", profileName: "Cody", revision: 1 },
    settledAt: null,
    runs: runs() ?? [
      {
        id: "run-macbook-1",
        status: statuses.length > 1 ? statuses.shift() : statuses[0],
        providerInstanceId: instanceId,
        requestedAt: "2026-10-22T03:40:00.000Z",
        completedAt: null,
      },
    ],
    messages: [
      {
        id: "message-1",
        role: "user",
        text: "Turn on the six permissions.",
        runId: "run-macbook-1",
      },
      {
        id: "message-2",
        role: "assistant",
        text: "Cloudflare is logged in.",
        runId: "run-macbook-1",
      },
    ],
    runtimeRequests: [],
    createdAt: "2026-10-22T03:40:00.000Z",
    updatedAt: "2026-10-22T03:44:00.000Z",
  });
  let readsLeft = Infinity;
  const answer = (method: string, args: ReadonlyArray<any>): unknown => {
    if (readsLeft <= 0 || (method === "getThread" && readsLeft-- <= 0)) {
      throw new Error("The MacBook did not answer.");
    }
    switch (method) {
      case "listEnvironments":
        return [
          {
            environmentId: macBook,
            label: "MacBook",
            targetKind: "bearer",
            connectionState: "connected",
          },
        ];
      case "listProfiles":
        return [
          {
            profileId: "cody",
            name: "Cody",
            revision: 1,
            runtimeMode: "full-access",
            interactionMode: "default",
            modelSelection,
          },
        ];
      case "resolveProfileModelSelection":
        return modelSelection;
      case "createThread":
        return { requestId: args[0].requestId, status: "accepted", threadId: args[0].threadId };
      case "sendMessage":
        return {
          requestId: args[0].requestId,
          messageId: args[0].messageId,
          status: "accepted",
          threadId: args[0].threadId,
        };
      case "listThreads":
        return { items: [], snapshotAt: "now" };
      case "getThread":
        if (args[1] === missing)
          throw new Error(`Failed to load orchestration V2 thread ${missing}`);
        return thread(args[1]);
      default:
        return undefined;
    }
  };
  return {
    calls,
    answer,
    called: (method: string) => calls.filter((call) => call.method === method),
    /** Answers `reads` more thread reads, then nothing at all. */
    stopAnsweringAfter: (reads: number) => {
      readsLeft = reads;
    },
  };
};

const makeLayer = (macbook: ReturnType<typeof makeMacBook>, record: TestRecord) => {
  const localPort = {
    listEnvironments: async () => [
      {
        environmentId: devBox,
        label: "dev-box",
        targetKind: "primary",
        connectionState: "connected",
      },
    ],
  } as unknown as GatewayRuntimePort;
  // The desktop app connected to both machines, granted the MacBook.
  const broker = Layer.effect(
    McpGatewayBroker,
    Effect.gen(function* () {
      const broker = yield* McpGatewayBrokerModule.make;
      yield* broker.connect("desktop", { [macBook]: ["read", "create", "send"] }).pipe(
        Stream.runForEach((event) => {
          macbook.calls.push({ method: event.method, args: event.args });
          const reply = (() => {
            try {
              return { result: macbook.answer(event.method, event.args) };
            } catch (error) {
              return { error: (error as Error).message };
            }
          })();
          return broker.respond("desktop", {
            connectionId: event.connectionId,
            invocationId: event.invocationId,
            ...reply,
          });
        }),
        Effect.forkScoped({ startImmediately: true }),
      );
      return broker;
    }),
  ).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));
  return Layer.mergeAll(
    broker,
    Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
    Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({ discard: () => Effect.void }),
    Layer.succeed(LocalGatewayPort, {
      environmentId: devBox,
      label: "dev-box",
      port: localPort,
      events: { subscribe: () => () => undefined },
    }),
    Layer.succeed(McpInvocationContext.McpInvocationContext, {
      environmentId: devBox,
      requestNamespace: "thread:captain",
      thread: { threadId: captain, providerSessionId: "session", providerInstanceId: instanceId },
      client: undefined,
      issuedAt: 0,
      capabilities: new Set(["orchestration" as const]),
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (threadId) =>
        Effect.succeed(threadId === captain ? { ...callerShell, ...record.caller } : null),
    }),
    Layer.mock(ThreadLaunch.ThreadLaunchService)({
      launch: (input) => {
        record.launches.push(input);
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
    Layer.mock(ThreadTaskService.ThreadTaskService)({
      assign: (owner, input, env) => {
        record.assigned.push({ owner, input, env });
        return Effect.succeed({} as never);
      },
      authorizeMessage: (input) => {
        record.authorized.push(input.targetThreadId);
        return Effect.void;
      },
    }),
    Layer.mock(OrchestratorMcpService.OrchestratorMcpService)({}),
    Layer.mock(ThreadMetadataMcpService.ThreadMetadataMcpService)({}),
    Layer.mock(Project.ProjectService)({}),
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/projects" }),
    Layer.mock(GitVcsDriver.GitVcsDriver)({}),
    Layer.mock(DocumentText.DocumentText)({}),
    Layer.mock(PeerForwarding.PeerForwarding)({}),
    Layer.mock(PeerLinkRequests.PeerLinkRequests)({}),
    Layer.mock(PeerLinks.PeerLinks)({ get: () => Effect.succeedNone }),
    Layer.mock(TailnetDevices.TailnetDevices)({}),
    Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({}),
    NodeCrypto.layer,
    NodeServices.layer,
    ServerSettings.layerTest({ mcpGatewayProfiles: record.profiles } as never),
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-remote-threads-" }).pipe(
      Layer.provide(NodeServices.layer),
    ),
  );
};

type TestRecord = ReturnType<typeof newRecord>;

const newRecord = (
  options: {
    readonly caller?: Partial<OrchestrationV2ThreadShell>;
    readonly profiles?: ReadonlyArray<unknown>;
  } = {},
) => ({
  launches: [] as Array<ThreadLaunch.ThreadLaunchInput>,
  assigned: [] as Array<{
    readonly owner: unknown;
    readonly input: unknown;
    readonly env: unknown;
  }>,
  authorized: [] as Array<ThreadId | null>,
  caller: options.caller ?? {},
  profiles: options.profiles ?? [],
});

/** Runs one tool call the way the MCP server does, against the test's single layer. */
const launch = (args: Record<string, unknown>) =>
  Effect.gen(function* () {
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer)),
    );
    const output = yield* toolkit
      .handle("t3_thread_launch", args as never)
      .pipe(Stream.unwrap, Stream.runCollect);
    return output.at(-1)!;
  });

const orchestrate = (
  name: "t3_thread_read" | "t3_thread_wait" | "t3_thread_send",
  args: Record<string, unknown>,
) =>
  Effect.gen(function* () {
    const toolkit = yield* OrchestratorToolkit.pipe(
      Effect.provide(McpToolAccess.HandlersLayer.layer(OrchestratorHandlers.layer)),
    );
    const output = yield* toolkit
      .handle(name, args as never)
      .pipe(Stream.unwrap, Stream.runCollect);
    return output.at(-1)!;
  });

/**
 * A clock whose sleeps wait for the test instead of time: each poll's backoff lands on `sleeps`
 * once the wait is parked on it, and `wake` lets that poll run.
 */
const makeSteppedClock = Effect.gen(function* () {
  const clock = yield* Clock.Clock;
  const sleeps = yield* Queue.unbounded<{
    readonly duration: Duration.Duration;
    readonly wake: Deferred.Deferred<void>;
  }>();
  const stepped: Clock.Clock = {
    ...clock,
    // Relayed calls run under the waiting chat's clock too; their timeout stays on the real one.
    sleep: (duration) =>
      Duration.toMillis(duration) >= 60_000
        ? clock.sleep(duration)
        : Effect.gen(function* () {
            const wake = yield* Deferred.make<void>();
            yield* Queue.offer(sleeps, { duration, wake });
            yield* Deferred.await(wake);
          }),
  };
  /** Waits for the next poll's sleep, releases it, and returns how long it asked for. */
  const step = Effect.gen(function* () {
    const sleep = yield* Queue.take(sleeps);
    yield* Deferred.succeed(sleep.wake, undefined);
    return Duration.toMillis(sleep.duration);
  });
  return { stepped, step };
});

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "test", version: "1" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

it.effect("a launch naming another environment lands there, never on this one", () => {
  const macbook = makeMacBook();
  const record = newRecord();
  return Effect.gen(function* () {
    const output = yield* launch({
      environmentId: macBook,
      projectId: "project:macbook",
      profileId: "cody",
      title: "Configure Accessibility",
      message: "Turn on the six permissions.",
    });
    expect(output.isFailure).toBe(false);
    expect(output.result).toMatchObject({
      environmentId: macBook,
      projectId: "project:macbook",
      runId: "run-macbook-1",
    });
    expect(record.launches).toEqual([]);
    const [created] = macbook.called("createThread");
    expect(created?.args[0]).toMatchObject({
      environmentId: macBook,
      projectId: "project:macbook",
      parentThreadId: captain,
      parentEnvironmentId: devBox,
    });
    expect(macbook.called("sendMessage")).toHaveLength(1);
    // The named child becomes the caller's task, which is what puts it in the caller's sweep.
    expect(record.assigned).toEqual([
      {
        owner: { kind: "thread", threadId: captain },
        input: {
          threadId: (output.result as { threadId: string }).threadId,
          summary: "Configure Accessibility",
          clientRequestId: `launch:${(output.result as { threadId: string }).threadId}`,
        },
        env: macBook,
      },
    ]);
  }).pipe(Effect.provide(makeLayer(macbook, record)));
});

it.effect("a remote launch retried with its clientRequestId replays the same thread", () => {
  const macbook = makeMacBook();
  const record = newRecord();
  return Effect.gen(function* () {
    const args = {
      environmentId: macBook,
      projectId: "project:macbook",
      title: "Configure Accessibility",
      message: "Turn on the six permissions.",
    };
    const first = yield* launch({ ...args, clientRequestId: "cody-1" });
    const retry = yield* launch({ ...args, clientRequestId: "cody-1" });
    const other = yield* launch(args);
    const threadIds = macbook
      .called("createThread")
      .map((call) => (call.args[0] as { threadId: string }).threadId);
    expect(threadIds[0]).toBe(threadIds[1]);
    expect(threadIds[2]).not.toBe(threadIds[0]);
    expect((retry.result as { threadId: string }).threadId).toBe(
      (first.result as { threadId: string }).threadId,
    );
    expect((other.result as { threadId: string }).threadId).not.toBe(
      (first.result as { threadId: string }).threadId,
    );
  }).pipe(Effect.provide(makeLayer(macbook, record)));
});

it.effect("an unknown environment is refused before anything launches", () => {
  const macbook = makeMacBook();
  const record = newRecord();
  return Effect.gen(function* () {
    const output = yield* launch({
      environmentId: "environment-typo",
      scratch: true,
      title: "Configure Accessibility",
      message: "Turn on the six permissions.",
    });
    expect(output.isFailure).toBe(true);
    expect(output.result).toMatchObject({ code: "invalid_request" });
    const message = (output.result as { message: string }).message;
    expect(message).toContain("environment-typo");
    expect(message).toContain(`${macBook} (MacBook)`);
    expect(record.launches).toEqual([]);
    expect(macbook.called("createThread")).toEqual([]);
  }).pipe(Effect.provide(makeLayer(macbook, record)));
});

it.effect("a remote launch refuses what it cannot honor there instead of dropping it", () => {
  const macbook = makeMacBook();
  const record = newRecord();
  return Effect.gen(function* () {
    const scratch = yield* launch({ environmentId: macBook, scratch: true, title: "x" });
    expect(scratch.result).toMatchObject({ code: "invalid_request" });
    const existing = yield* launch({
      environmentId: macBook,
      projectId: "project:macbook",
      title: "x",
      workspaceStrategy: { type: "existing_worktree", worktreePath: "/Users/jj/repo" },
    });
    expect(existing.result).toMatchObject({ code: "invalid_request" });
    expect(record.launches).toEqual([]);
    expect(macbook.called("createThread")).toEqual([]);
  }).pipe(Effect.provide(makeLayer(macbook, record)));
});

it.effect("a launch without environmentId stays on this environment and says so", () => {
  const macbook = makeMacBook();
  const record = newRecord();
  return Effect.gen(function* () {
    const output = yield* launch({ title: "Audit", message: "Review the change" });
    expect(output.result).toMatchObject({ environmentId: devBox, modelSelection });
    expect(record.launches).toHaveLength(1);
    expect(record.launches[0]?.parentThreadId).toBe(captain);
    expect(macbook.calls).toEqual([]);
  }).pipe(Effect.provide(makeLayer(macbook, record)));
});

it.effect("waiting on a remote child returns when its run completes", () => {
  const macbook = makeMacBook(["running", "running", "completed"]);
  return Effect.gen(function* () {
    const clock = yield* makeSteppedClock;
    const fiber = yield* orchestrate("t3_thread_wait", {
      environmentId: macBook,
      threadId: child,
      timeoutMs: 60 * 60 * 1_000,
    }).pipe(Effect.provideService(Clock.Clock, clock.stepped), Effect.forkChild);
    expect([yield* clock.step, yield* clock.step]).toEqual([1_000, 2_000]);
    const output = yield* Fiber.join(fiber);
    expect(output.result).toEqual({
      environmentId: macBook,
      threadId: child,
      runId: "run-macbook-1",
      status: "completed",
      timedOut: false,
    });
    expect(macbook.called("getThread")).toHaveLength(3);
  }).pipe(Effect.provide(makeLayer(macbook, newRecord())));
});

it.effect("a remote wait reports an environment that stops answering instead of failing", () => {
  const macbook = makeMacBook(["running"]);
  return Effect.gen(function* () {
    const clock = yield* makeSteppedClock;
    const wait = orchestrate("t3_thread_wait", {
      environmentId: macBook,
      threadId: child,
      timeoutMs: 60 * 60 * 1_000,
    }).pipe(Effect.provideService(Clock.Clock, clock.stepped));
    macbook.stopAnsweringAfter(1);
    const fiber = yield* Effect.forkChild(wait);
    // Each failed poll is tolerated until the last one.
    expect([yield* clock.step, yield* clock.step, yield* clock.step]).toEqual([
      1_000, 2_000, 4_000,
    ]);
    expect((yield* Fiber.join(fiber)).result).toMatchObject({
      runId: "run-macbook-1",
      status: "running",
      timedOut: true,
      unreachable: expect.stringContaining("did not answer"),
    });
    // Nothing seen yet: the wait still answers, with no run.
    expect((yield* wait).result).toMatchObject({
      runId: null,
      status: "idle",
      timedOut: true,
      unreachable: expect.any(String),
    });
  }).pipe(Effect.provide(makeLayer(macbook, newRecord())));
});

it.effect("reads and sends reach a remote child through its environmentId", () => {
  const macbook = makeMacBook();
  return Effect.gen(function* () {
    const read = yield* orchestrate("t3_thread_read", { environmentId: macBook, threadId: child });
    expect(read.result).toMatchObject({
      environmentId: macBook,
      thread: {
        threadId: child,
        status: "running",
        parentEnvironmentId: devBox,
        profile: { profileId: "cody", profileName: "Cody" },
      },
      items: [
        { type: "user_message", text: "Turn on the six permissions." },
        { type: "assistant_message", text: "Cloudflare is logged in." },
      ],
    });
    const sent = yield* orchestrate("t3_thread_send", {
      environmentId: macBook,
      threadId: child,
      message: "Accept the dev-box host key.",
    });
    expect(sent.result).toMatchObject({
      environmentId: macBook,
      threadId: child,
      delivery: "accepted",
    });
    expect(macbook.called("sendMessage")[0]?.args[0]).toMatchObject({
      environmentId: macBook,
      threadId: child,
      text: "Accept the dev-box host key.",
    });
    const absent = yield* orchestrate("t3_thread_read", {
      environmentId: macBook,
      threadId: missing,
    });
    expect(absent.result).toMatchObject({ code: "thread_not_found" });
    const steer = yield* orchestrate("t3_thread_send", {
      environmentId: macBook,
      threadId: child,
      message: "Stop.",
      mode: "steer",
    });
    expect(steer.result).toMatchObject({ code: "invalid_request" });
  }).pipe(Effect.provide(makeLayer(macbook, newRecord())));
});

it.effect("launch, create, delegate, send, and wait reject parameters they do not know", () => {
  const record = newRecord();
  return Effect.gen(function* () {
    const mcp = yield* McpServer.McpServer;
    const tools = new Map(mcp.tools.map(({ tool }) => [tool.name, tool]));
    for (const name of [
      "t3_thread_launch",
      "create_threads",
      "delegate_task",
      "t3_thread_read",
      "t3_thread_send",
      "t3_thread_wait",
    ]) {
      expect(tools.get(name)?.inputSchema).toMatchObject({ additionalProperties: false });
    }
    const refused = yield* mcp
      .callTool({ name: "t3_thread_launch", arguments: { title: "x", machine: "macbook" } })
      .pipe(Effect.provideService(McpSchema.McpServerClient, mcpClient), Effect.flip);
    expect(refused.message).toContain("excess property");
    expect(record.launches).toEqual([]);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        toolkitRegistration(ProjectToolkit, ProjectHandlers.layer),
        toolkitRegistration(OrchestratorToolkit, OrchestratorHandlers.layer),
      ).pipe(
        Layer.provideMerge(layerInProcessMcpServer),
        Layer.provideMerge(makeLayer(makeMacBook(), record)),
      ),
    ),
  );
});

it.effect(
  "t3_create_and_start_thread on another environment also puts the child in the sweep",
  () => {
    const macbook = makeMacBook();
    const record = newRecord();
    return Effect.gen(function* () {
      const mcp = yield* McpServer.McpServer;
      const result = yield* mcp
        .callTool({
          name: "t3_create_and_start_thread",
          arguments: {
            environmentId: macBook,
            projectId: "project:macbook",
            profileId: "cody",
            title: "Configure Accessibility",
            text: "Turn on the six permissions.",
            idempotencyKey: "cody-macbook-1",
          },
        })
        .pipe(Effect.provideService(McpSchema.McpServerClient, mcpClient));
      expect(result.isError).toBe(false);
      const [created] = macbook.called("createThread");
      expect(created?.args[0]).toMatchObject({ environmentId: macBook, parentThreadId: captain });
      expect(record.assigned).toEqual([
        {
          owner: { kind: "thread", threadId: captain },
          input: {
            threadId: (created!.args[0] as { threadId: string }).threadId,
            summary: "Configure Accessibility",
            clientRequestId: `launch:${(created!.args[0] as { threadId: string }).threadId}`,
          },
          env: macBook,
        },
      ]);
    }).pipe(
      Effect.provide(
        layerAgentsToolkit.pipe(
          Layer.provideMerge(McpServer.McpServer.layer),
          Layer.provideMerge(makeLayer(macbook, record)),
        ),
      ),
    );
  },
);

it.effect("a remote wait follows a restart to the run that continues the work", () => {
  const macbook = makeMacBook(
    [],
    [
      [{ id: "run-1", status: "running" }],
      [
        { id: "run-1", status: "interrupted" },
        { id: "run-2", status: "running" },
      ],
      [
        { id: "run-1", status: "interrupted" },
        { id: "run-2", status: "completed" },
      ],
    ],
  );
  return Effect.gen(function* () {
    const clock = yield* makeSteppedClock;
    const fiber = yield* orchestrate("t3_thread_wait", {
      environmentId: macBook,
      threadId: child,
    }).pipe(Effect.provideService(Clock.Clock, clock.stepped), Effect.forkChild);
    yield* clock.step;
    yield* clock.step;
    const output = yield* Fiber.join(fiber);
    expect(output.result).toMatchObject({ runId: "run-2", status: "completed", timedOut: false });
  }).pipe(Effect.provide(makeLayer(macbook, newRecord())));
});

it.effect("an agent whose modes exceed the caller's is refused on another environment", () => {
  const macbook = makeMacBook();
  const record = newRecord({
    caller: { runtimeMode: "approval-required" },
    profiles: [
      {
        profileId: "cody",
        name: "Cody",
        revision: 1,
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-01T00:00:00.000Z",
        runtimeMode: "full-access",
        interactionMode: "default",
      },
    ],
  });
  return Effect.gen(function* () {
    const output = yield* launch({
      environmentId: macBook,
      projectId: "project:macbook",
      profileId: "cody",
      title: "x",
      message: "y",
    });
    expect(output.result).toMatchObject({ code: "runtime_mode_escalation_denied" });
    expect(macbook.called("createThread")).toEqual([]);
  }).pipe(Effect.provide(makeLayer(macbook, record)));
});

it.effect("a chat messages its own child on another environment without the worker check", () => {
  const macbook = makeMacBook();
  const record = newRecord();
  return Effect.gen(function* () {
    yield* orchestrate("t3_thread_send", {
      environmentId: macBook,
      threadId: child,
      message: "Continue.",
    });
    // The fake child is nested under this caller on dev-box, so it is the caller's own child.
    expect(record.authorized).toEqual([]);
    expect(macbook.called("sendMessage")).toHaveLength(1);
  }).pipe(Effect.provide(makeLayer(macbook, record)));
});
