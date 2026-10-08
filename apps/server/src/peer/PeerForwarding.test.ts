import { NodeHttpServer } from "@effect/platform-node";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  type OrchestrationV2Run,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { McpSchema, McpServer } from "effect/ai";

import * as ServerConfig from "../config.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as SourceControlRepositoryService from "../sourceControl/SourceControlRepositoryService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as PeerForwarding from "./PeerForwarding.ts";
import * as PeerLinks from "./PeerLinks.ts";
import { descriptorOf, layerLinkingEnvironment, linkTo, servePeer } from "./PeerLinks.testkit.ts";

const laptop = descriptorOf("environment-laptop", "Laptop");
const box = descriptorOf("environment-box", "Box");
const boxProject = ProjectId.make("project:box");
const boxThread = ThreadId.make("thread:box-auto");
const boxRun = RunId.make("run:box-auto");

/** What B's thread service was asked to do. */
interface Seen {
  readonly sends: ReadonlyArray<ThreadManagement.ThreadManagementSendInput>;
  readonly waits: ReadonlyArray<ThreadManagement.ThreadManagementWaitInput>;
  readonly launches: ReadonlyArray<ThreadLaunch.ThreadLaunchInput>;
  /** Commands dispatched and delegated-task stops, as `<type> <threadId>`. */
  readonly stops: ReadonlyArray<string>;
}
const nothingSeen: Seen = { sends: [], waits: [], launches: [], stops: [] };

/**
 * B's threads: one `auto` thread in `boxProject`, whose run finishes on the
 * third wait. Every send and wait is recorded.
 */
const boxThreads = (seen: Ref.Ref<Seen>) => {
  const shell = { ...liveThreadShell(boxThread, { runtimeMode: "auto" }), projectId: boxProject };
  const run = (status: OrchestrationV2Run["status"]) =>
    ({ id: boxRun, status }) as unknown as OrchestrationV2Run;
  const projection = { thread: shell, runs: [run("running")], runtimeRequests: [] } as never;
  return Layer.mock(ThreadManagement.ThreadManagementService)({
    getThreadShell: (threadId) => Effect.succeed(threadId === boxThread ? shell : null),
    getProjectThreadRecords: () => Effect.succeed(projection),
    getThreadRecords: () => Effect.succeed(projection),
    listProjectThreads: () => Effect.succeed([shell] as never),
    sendToThread: (input) =>
      Ref.update(seen, (current) => ({ ...current, sends: [...current.sends, input] })).pipe(
        Effect.as({ run: run("running"), delivery: "started" } as never),
      ),
    dispatch: (command) =>
      Ref.update(seen, (current) => ({
        ...current,
        stops: [
          ...current.stops,
          `${command.type} ${"threadId" in command ? command.threadId : ""}`,
        ],
      })).pipe(
        // The stop interrupts the thread's running run.
        Effect.as({
          sequence: 0,
          storedEvents: [
            {
              sequence: 1,
              commandId: command.commandId,
              event: { type: "run.updated", runId: boxRun },
            },
          ],
        } as never),
      ),
    stopDelegatedTasks: (input) =>
      Ref.update(seen, (current) => ({
        ...current,
        stops: [...current.stops, `delegated-tasks.stop ${input.threadId}`],
      })),
    waitForThread: (input) =>
      Ref.updateAndGet(seen, (current) => ({ ...current, waits: [...current.waits, input] })).pipe(
        Effect.map(({ waits }) => ({
          threadId: input.threadId,
          run: run(waits.length < 3 ? "running" : "completed"),
          timedOut: waits.length < 3,
        })),
      ),
  });
};

/** B launches whatever it is asked to, and records it. */
const boxLaunches = (seen: Ref.Ref<Seen>) =>
  Layer.mock(ThreadLaunch.ThreadLaunchService)({
    launch: (input) =>
      Ref.update(seen, (current) => ({ ...current, launches: [...current.launches, input] })).pipe(
        Effect.as({
          threadId: input.threadId,
          projection: {
            thread: {
              id: input.threadId,
              projectId: input.projectId,
              modelSelection: input.modelSelection,
              title: input.title,
            },
            runs: [],
          },
          resumed: false,
        } as unknown as ThreadLaunch.ThreadLaunchResult),
      ),
  });

/** The orchestrator and project toolkits on B's real `/mcp`, behind its real OAuth. */
const serveBox = (seen: Ref.Ref<Seen>) =>
  servePeer(
    box,
    Layer.merge(
      McpHttpServer.layerOrchestratorToolkit,
      McpHttpServer.layerProjectRegistration,
    ).pipe(
      Layer.provide(NodeCrypto.layer),
      Layer.provide(boxThreads(seen)),
      Layer.provide(boxLaunches(seen)),
      Layer.provide(
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/projects" }),
      ),
      Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
      Layer.provide(Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({})),
      Layer.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-peer-forwarding-box-" }).pipe(
          Layer.provide(NodeServices.layer),
        ),
      ),
      Layer.provide(NodeServices.layer),
      Layer.provide(Layer.mock(ProviderRegistry.ProviderRegistry)({})),
      Layer.provide(Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({})),
      Layer.provide(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
      Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
      Layer.provide(Layer.mock(SecretRequests.SecretRequests)({})),
    ),
  );

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "peer-forwarding-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "peer-forwarding-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

/**
 * Environment A: its own orchestrator toolkit with forwarding, and a thread
 * caller whose modes the test picks. Its local threads never matter here.
 */
const makeLaptop = Effect.gen(function* () {
  const linking = yield* layerLinkingEnvironment(laptop).pipe(Layer.build);
  const layerHere = Layer.merge(
    McpHttpServer.layerOrchestratorToolkit,
    McpHttpServer.layerProjectRegistration,
  ).pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provide(Layer.mock(ThreadLaunch.ThreadLaunchService)({})),
    Layer.provide(
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/projects" }),
    ),
    Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
    Layer.provide(Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({})),
    Layer.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-peer-forwarding-laptop-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    ),
    Layer.provide(NodeServices.layer),
    Layer.provide(PeerForwarding.layer),
    Layer.provide(Layer.succeedContext(linking)),
    Layer.provide(NodeCrypto.layer),
    Layer.provideMerge(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (threadId) =>
          Effect.succeed(
            liveThreadShell(
              threadId,
              threadId === ThreadId.make("thread:laptop-plan")
                ? { runtimeMode: "full-access", interactionMode: "plan" }
                : { runtimeMode: "full-access" },
            ),
          ),
      }),
    ),
    Layer.provide(Layer.mock(ProviderRegistry.ProviderRegistry)({})),
    Layer.provide(Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({})),
    Layer.provide(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
    Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
    Layer.provide(Layer.mock(SecretRequests.SecretRequests)({})),
    Layer.fresh,
  );
  const here = yield* Layer.build(layerHere);
  const server = Context.get(here, McpServer.McpServer);
  const scopeOf = (caller: string): McpInvocationContext.McpInvocationScope => ({
    environmentId: laptop.environmentId,
    requestNamespace: `provider-session:${caller}`,
    thread: {
      threadId: ThreadId.make(caller),
      providerSessionId: `provider-session:${caller}`,
      providerInstanceId: ProviderInstanceId.make("codex"),
    },
    client: undefined,
    capabilities: new Set(["orchestration"]),
    issuedAt: 1,
  });
  const call = (caller: string, name: string, args: Record<string, unknown>) =>
    server
      .callTool({ name, arguments: args })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scopeOf(caller)),
        Effect.provideService(McpSchema.McpServerClient, mcpClient),
      );
  return { links: Context.get(linking, PeerLinks.PeerLinks), call };
});

const failureOf = (result: McpSchema.CallToolResult) => {
  const text = result.content[0];
  return result.isError === true && text?.type === "text" ? JSON.parse(text.text) : undefined;
};

it.effect("an agent here works on a linked environment's threads within its own modes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const seen = yield* Ref.make<Seen>(nothingSeen);
      const b = yield* serveBox(seen);
      const a = yield* makeLaptop;
      yield* linkTo(a.links, b, "auto");

      const listed = yield* a.call("thread:laptop-full", "t3_environment_links", {});
      expect(listed.structuredContent).toMatchObject({
        environmentId: laptop.environmentId,
        links: [
          { environmentId: box.environmentId, label: "Box", status: "reachable", access: "auto" },
        ],
      });

      const threads = yield* a.call("thread:laptop-full", "t3_thread_list", {
        environmentId: box.environmentId,
        projectId: boxProject,
      });
      expect(threads.isError).toBe(false);
      expect(threads.structuredContent).toMatchObject({
        projectId: boxProject,
        threads: [{ threadId: boxThread, runtimeMode: "auto" }],
      });

      // A full-access agent here is held to the link's `auto` there, which
      // the box's `auto` thread is within.
      const sent = yield* a.call("thread:laptop-full", "t3_thread_send", {
        environmentId: box.environmentId,
        threadId: boxThread,
        message: "Carry on there.",
        clientRequestId: "send-1",
      });
      expect(sent.isError).toBe(false);
      expect(sent.structuredContent).toMatchObject({ threadId: boxThread, delivery: "started" });

      // A plan-mode agent here may not steer that thread there: the box
      // refuses it, because the call carries the agent's own modes.
      const planned = yield* a.call("thread:laptop-plan", "t3_thread_send", {
        environmentId: box.environmentId,
        threadId: boxThread,
        message: "Change course.",
      });
      expect(failureOf(planned)).toMatchObject({ code: "interaction_mode_escalation_denied" });
      expect((yield* Ref.get(seen)).sends).toHaveLength(1);

      // stop=true stops the thread there as its Stop button does: the whole
      // thread and the tasks it delegated, not just the running turn.
      const stopped = yield* a.call("thread:laptop-full", "t3_thread_interrupt", {
        environmentId: box.environmentId,
        threadId: boxThread,
        stop: true,
        clientRequestId: "stop-1",
      });
      expect(stopped.structuredContent).toMatchObject({
        threadId: boxThread,
        runId: boxRun,
        status: "interrupt_requested",
      });
      expect((yield* Ref.get(seen)).stops).toEqual([
        `thread.stop ${boxThread}`,
        `delegated-tasks.stop ${boxThread}`,
      ]);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("keeps a forwarded wait short and its retries scoped to the caller", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const seen = yield* Ref.make<Seen>(nothingSeen);
      const b = yield* serveBox(seen);
      const a = yield* makeLaptop;
      yield* linkTo(a.links, b, "auto");

      const waited = yield* a.call("thread:laptop-full", "t3_thread_wait", {
        environmentId: box.environmentId,
        threadId: boxThread,
        timeoutMs: 600_000,
      });
      expect(waited.structuredContent).toEqual({
        threadId: boxThread,
        runId: boxRun,
        status: "completed",
        timedOut: false,
      });
      // Three pieces of at most 50 s each, the later ones pinned to the run
      // the first one found.
      expect(
        (yield* Ref.get(seen)).waits.map(({ timeoutMs, runId }) => [timeoutMs, runId]),
      ).toEqual([
        [PeerForwarding.FORWARDED_WAIT_CHUNK_MS, undefined],
        [PeerForwarding.FORWARDED_WAIT_CHUNK_MS, boxRun],
        [PeerForwarding.FORWARDED_WAIT_CHUNK_MS, boxRun],
      ]);

      const send = (caller: string, clientRequestId: string) =>
        a.call(caller, "t3_thread_send", {
          environmentId: box.environmentId,
          threadId: boxThread,
          message: "Once.",
          clientRequestId,
        });
      yield* send("thread:laptop-full", "same-key");
      yield* send("thread:laptop-full", "same-key");
      yield* send("thread:laptop-other", "same-key");
      const [first, retried, other] = (yield* Ref.get(seen)).sends.map((input) => input.commandId);
      // The box sees every caller here as the one link, so the key is scoped
      // to its caller before it leaves: a retry matches, another agent's same
      // key does not.
      expect(retried).toBe(first);
      expect(other).not.toBe(first);
      expect(first).not.toContain("same-key");
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("launches in a linked environment with the caller's modes, retry-safe", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const seen = yield* Ref.make<Seen>(nothingSeen);
      const b = yield* serveBox(seen);
      const a = yield* makeLaptop;
      yield* linkTo(a.links, b, "full-access");
      const codex = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };
      const launch = (caller: string, args: Record<string, unknown> = {}) =>
        a.call(caller, "t3_thread_launch", {
          environmentId: box.environmentId,
          projectId: boxProject,
          title: "Run the suite there",
          modelSelection: codex,
          message: "Run the suite.",
          clientRequestId: "launch-1",
          ...args,
        });

      const first = yield* launch("thread:laptop-plan");
      expect(first.isError).toBe(false);
      expect(first.structuredContent).toMatchObject({
        projectId: boxProject,
        modelSelection: codex,
      });
      const retried = yield* launch("thread:laptop-plan");
      const [launched, relaunched] = (yield* Ref.get(seen)).launches;
      // The thread there runs with the caller's own modes here, below the
      // link's full access, and a retry asks for the same thread.
      expect(launched).toMatchObject({ runtimeMode: "full-access", interactionMode: "plan" });
      expect(relaunched?.threadId).toBe(launched?.threadId);
      expect(retried.structuredContent).toEqual(first.structuredContent);

      // An escalation past the caller's own modes is refused here.
      const escalated = yield* launch("thread:laptop-plan", { interactionMode: "default" });
      expect(failureOf(escalated)).toMatchObject({ code: "interaction_mode_escalation_denied" });
      // A pending upload lives here, so it cannot go along.
      yield* Ref.set(b.bearers, []);
      const withUpload = yield* launch("thread:laptop-full", {
        clientRequestId: "launch-2",
        attachments: [
          { type: "image", id: "upload-1", name: "a.png", mimeType: "image/png", sizeBytes: 1 },
        ],
      });
      expect(failureOf(withUpload)).toMatchObject({ code: "invalid_request" });
      expect(yield* Ref.get(b.bearers)).toEqual([]);
      expect((yield* Ref.get(seen)).launches).toHaveLength(2);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("refuses what a linked environment cannot take before anything leaves", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const seen = yield* Ref.make<Seen>(nothingSeen);
      const b = yield* serveBox(seen);
      const a = yield* makeLaptop;
      yield* linkTo(a.links, b, "auto");
      yield* Ref.set(b.bearers, []);

      const unknown = yield* a.call("thread:laptop-full", "t3_thread_read", {
        environmentId: EnvironmentId.make("environment-elsewhere"),
        threadId: boxThread,
      });
      expect(failureOf(unknown)).toMatchObject({ code: "invalid_request" });
      expect(yield* Ref.get(b.bearers)).toEqual([]);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);
