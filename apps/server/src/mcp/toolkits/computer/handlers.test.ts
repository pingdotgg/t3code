import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type ComputerAction,
  type ComputerHostConnectInput,
  type ComputerHostFrame,
  type ComputerHostId,
  type ComputerSnapshot,
  type ComputerTaskId,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SecureRandom from "effect/crypto/SecureRandom";
import { McpSchema, McpServer } from "effect/ai";

import * as ServerSettings from "../../../serverSettings.ts";
import * as ProjectionStore from "../../../orchestration-v2/ProjectionStore.ts";
import * as ComputerApprovals from "../../../computer/ComputerApprovals.ts";
import * as ComputerAudit from "../../../computer/ComputerAudit.ts";
import * as ComputerDecider from "../../../computer/ComputerDecider.ts";
import * as ComputerService from "../../../computer/ComputerService.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { liveThreadsLayer } from "../../McpToolAccess.testkit.ts";

const environmentId = EnvironmentId.make("environment-computer-test");
const threadId = ThreadId.make("thread-computer-test");
const providerInstanceId = ProviderInstanceId.make("codex");

const invocation = (
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability>,
): McpInvocationContext.McpInvocationScope => ({
  environmentId,
  requestNamespace: "provider-session-computer-test",
  thread: {
    threadId,
    providerSessionId: "provider-session-computer-test",
    providerInstanceId,
  },
  client: undefined,
  capabilities: new Set(capabilities),
  issuedAt: 1,
});

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "mcp-test", version: "1.0.0" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const hello: ComputerHostConnectInput = {
  name: "JJ's MacBook",
  device: "mac",
  platform: "darwin",
  version: "1.0",
  controls: ["open_app", "volume", "lock_screen"],
  computerUse: true,
  accessibility: true,
  screenRecording: true,
};

/** A fixed SecureRandom with a counter, so every host, task and decision gets its own id. */
const testRandom = () => {
  let seed = 0;
  return SecureRandom.make((size) => {
    seed += 1;
    const bytes = new Uint8Array(size);
    new DataView(bytes.buffer).setUint32(0, seed, false);
    return bytes;
  });
};

type FakeHost = {
  readonly hostId: ComputerHostId;
  readonly starts: Ref.Ref<ReadonlyArray<{ taskId: string; goal: string }>>;
  readonly authorize: (input: {
    readonly taskId: ComputerTaskId;
    readonly step: number;
    readonly action: ComputerAction;
  }) => ReturnType<ComputerService.ComputerService["Service"]["hostAuthorize"]>;
  readonly decide: (input: {
    readonly taskId: ComputerTaskId;
    readonly questions: Parameters<
      ComputerService.ComputerService["Service"]["hostDecide"]
    >[0]["questions"];
  }) => ReturnType<ComputerService.ComputerService["Service"]["hostDecide"]>;
  readonly step: (input: {
    readonly taskId: ComputerTaskId;
    readonly text: string;
  }) => ReturnType<ComputerService.ComputerService["Service"]["hostEvent"]>;
};

/** A computer that answers every command the way a real one would, and records its starts. */
const startHost = Effect.gen(function* () {
  const owner = "session-mac";
  const service = yield* ComputerService.ComputerService;
  const hostId = yield* Deferred.make<ComputerHostId>();
  const starts = yield* Ref.make<ReadonlyArray<{ taskId: string; goal: string }>>([]);
  const handle = (frame: ComputerHostFrame) =>
    Effect.gen(function* () {
      if (frame.kind === "welcome") {
        yield* Deferred.succeed(hostId, frame.hostId);
        return;
      }
      if (frame.kind === "stop") {
        yield* service.hostEvent({
          hostId: yield* Deferred.await(hostId),
          owner,
          taskId: frame.taskId,
          event: { type: "finished", status: "stopped", reason: "", steps: [], surface: null },
        });
        return;
      }
      if (frame.kind === "start") {
        yield* Ref.update(starts, (current) => [
          ...current,
          { taskId: frame.taskId, goal: frame.goal },
        ]);
      }
      const id = yield* Deferred.await(hostId);
      yield* service.hostRespond({
        hostId: id,
        owner,
        reply: {
          requestId: frame.requestId,
          ok: true,
          ...(frame.kind === "control" ? { done: "Done." } : {}),
        },
      });
    });
  yield* Stream.runForEach(service.hostConnect({ ...hello, owner }), handle).pipe(
    Effect.forkScoped,
  );
  const id = yield* Deferred.await(hostId);
  return {
    hostId: id,
    starts,
    authorize: (input) =>
      service.hostAuthorize({
        hostId: id,
        owner,
        taskId: input.taskId,
        step: input.step,
        observation: { app: "Messages", title: "Dana" },
        action: input.action,
      }),
    decide: (input) =>
      service.hostDecide({
        hostId: id,
        owner,
        taskId: input.taskId,
        state: {},
        questions: input.questions,
      }),
    step: (input) =>
      service.hostEvent({
        hostId: id,
        owner,
        taskId: input.taskId,
        event: { type: "step", text: input.text },
      }),
  } satisfies FakeHost;
});

const layerComputerService = (overrides: Parameters<typeof ServerSettings.layerTest>[0] = {}) => {
  const random = testRandom();
  const dependencies = Layer.mergeAll(
    Layer.effect(
      ComputerAudit.ComputerAudit,
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const paths = yield* Path.Path;
        const directory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-mcp-computer-",
        });
        return yield* ComputerAudit.make(paths.join(directory, "computer", "audit.jsonl"));
      }),
    ),
    ServerSettings.layerTest(overrides),
    Layer.succeed(SecureRandom.SecureRandom, random),
  );
  return ComputerService.layer.pipe(
    Layer.provide(ComputerApprovals.layer),
    Layer.provide(
      Layer.succeed(
        ComputerDecider.ComputerDecider,
        ComputerDecider.ComputerDecider.of({
          ask: () => Effect.succeed({ _tag: "not_configured" } as const),
        }),
      ),
    ),
    Layer.provide(
      Layer.mock(ProjectionStore.ProjectionStoreV2)({
        getThreadShell: () => Effect.succeed(null),
      }),
    ),
    Layer.provide(dependencies),
  );
};

/** The toolkit as `/mcp` registers it, called in process as the auth middleware does. */
const layerTest = (overrides: Parameters<typeof ServerSettings.layerTest>[0] = {}) =>
  McpHttpServer.layerComputerToolkit.pipe(
    Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
    Layer.provideMerge(layerComputerService(overrides)),
    Layer.provide(liveThreadsLayer),
    Layer.provide(NodeServices.layer),
  );

const textOf = (result: McpSchema.CallToolResult) =>
  result.content.flatMap((entry) => (entry.type === "text" ? [entry.text] : [])).join("\n");

/** Runs one tool as the calling thread, or as a session holding `capabilities`. */
const call = (
  name: string,
  args: Readonly<Record<string, unknown>>,
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability> = ["computer"],
) =>
  McpServer.McpServer.pipe(
    Effect.flatMap((server) => server.callTool({ name, arguments: args })),
    Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(capabilities)),
    Effect.provideService(McpSchema.McpServerClient, client),
  );

/** One task the service has, once its predicate holds. */
const taskWhere = (predicate: (task: ComputerSnapshot["tasks"][number]) => boolean) =>
  Effect.gen(function* () {
    const service = yield* ComputerService.ComputerService;
    const snapshots = yield* service.subscribe({ revealTypedText: true });
    const found = yield* snapshots.pipe(
      Stream.filter((snapshot) => snapshot.tasks.some(predicate)),
      Stream.runHead,
    );
    if (found._tag === "None") return yield* Effect.die("the task never started");
    return found.value.tasks.find(predicate)!;
  });

const click = (label: string): ComputerAction => ({
  kind: "click",
  ref: "r1",
  role: "button",
  label,
});

describe("computer toolkit", () => {
  it.effect("registers the six tools, and refuses each without the capability", () =>
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      expect(server.tools.map(({ tool }) => tool.name).toSorted()).toEqual([
        "computer_act",
        "computer_control",
        "computer_look",
        "computer_status",
        "computer_stop",
        "computer_use",
      ]);

      for (const [name, args] of [
        ["computer_status", {}],
        ["computer_look", {}],
        ["computer_act", { action: "key", key: "return" }],
        ["computer_control", { kind: "open_app", app: "Safari" }],
        ["computer_use", { goal: "open the draft" }],
        ["computer_stop", {}],
      ] as const) {
        const refused = yield* call(name, args, ["orchestration"]);
        expect(refused.isError).toBe(true);
        // The agent can't see Settings, and a running session keeps the capabilities it started with.
        expect(textOf(refused)).toContain("Agent computer use is turned off for this environment.");
        expect(textOf(refused)).toContain("Settings → Computer use");
      }

      // A refused call starts nothing.
      const service = yield* ComputerService.ComputerService;
      expect((yield* service.status(null)).tasks).toEqual([]);
      expect(yield* Ref.get((yield* startHost).starts)).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(layerTest())),
  );

  it.effect("computer_control runs a fixed action and reports it done", () =>
    Effect.gen(function* () {
      yield* startHost;
      const result = yield* call("computer_control", { kind: "open_app", app: "Safari" });
      expect(result.isError).toBe(false);
      expect(result.structuredContent).toMatchObject({
        task: {
          kind: "control",
          goal: "open Safari",
          status: "done",
          threadId,
          requester: `agent: ${providerInstanceId}`,
        },
        next: "",
      });
    }).pipe(Effect.scoped, Effect.provide(layerTest())),
  );

  it.effect("computer_use returns the planner's questions, and answers advance the task", () =>
    Effect.gen(function* () {
      const host = yield* startHost;
      const use = yield* call("computer_use", {
        goal: "reply to Dana that I am coming",
        text: "on my way",
      }).pipe(Effect.forkScoped);

      const task = yield* taskWhere((candidate) => candidate.kind === "use");
      expect(task).toMatchObject({ threadId, goal: "reply to Dana that I am coming" });

      // The helper asks what to do next; with no grounder those questions come to the agent.
      const decided = yield* host
        .decide({
          taskId: task.taskId,
          questions: {
            next: {
              type: "choice",
              instructions: "What next?",
              criteria: { c0: "Click Send", stuck: "None" },
            },
          },
        })
        .pipe(Effect.forkScoped);

      const first = yield* Fiber.join(use);
      expect(first.isError).toBe(false);
      const progress = first.structuredContent as {
        task: { taskId: string; pendingDecision: { id: string } | null; status: string };
        next: string;
      };
      expect(progress.task.status).toBe("running");
      expect(progress.task.pendingDecision?.id).toBeTruthy();
      expect(progress.next).toContain("decisionId");

      const answered = yield* call("computer_use", {
        taskId: progress.task.taskId,
        decisionId: progress.task.pendingDecision!.id,
        answers: { next: { choice: "c0", confidence: "high" } },
      });
      expect(answered.isError).toBe(false);
      expect(answered.structuredContent).toMatchObject({
        task: { taskId: progress.task.taskId },
      });
      expect(yield* Fiber.join(decided)).toEqual({
        next: { type: "choice", choice: "c0", probability: 0.9 },
      });
    }).pipe(Effect.scoped, Effect.provide(layerTest())),
  );

  it.effect("says a step waits for the user's tap, and no tool could answer one", () =>
    Effect.gen(function* () {
      const host = yield* startHost;
      const use = yield* call("computer_use", { goal: "open the draft" }).pipe(Effect.forkScoped);
      const task = yield* taskWhere((candidate) => candidate.kind === "use");
      yield* host
        .authorize({ taskId: task.taskId, step: 1, action: click("Send") })
        .pipe(Effect.forkScoped);

      const result = yield* Fiber.join(use);
      expect(result.isError).toBe(false);
      expect(result.structuredContent).toMatchObject({
        task: { waitingForApproval: expect.any(String), status: "running" },
      });
      expect((result.structuredContent as { next: string }).next).toContain(
        "You cannot approve it",
      );

      // No MCP tool answers a computer approval: none takes an approval id or an answer.
      const server = yield* McpServer.McpServer;
      for (const { tool } of server.tools) {
        const properties = (tool.inputSchema as { properties?: Record<string, unknown> })
          .properties;
        expect(Object.keys(properties ?? {})).not.toContain("approvalId");
        expect(Object.keys(properties ?? {})).not.toContain("approve");
      }
    }).pipe(Effect.scoped, Effect.provide(layerTest())),
  );

  it.effect("with approvals skipped the same step runs and nothing is pending", () =>
    Effect.gen(function* () {
      const host = yield* startHost;
      const use = yield* call("computer_use", { goal: "open the draft" }).pipe(Effect.forkScoped);
      const task = yield* taskWhere((candidate) => candidate.kind === "use");

      // A consequential click the policy would tap runs at once under skip mode.
      expect(
        yield* host.authorize({ taskId: task.taskId, step: 1, action: click("Send") }),
      ).toEqual({ ok: true, grant: "approved" });
      // The helper reports the step it took, which is what a start returns on.
      yield* host.step({ taskId: task.taskId, text: "clicked Send" });

      const result = yield* Fiber.join(use);
      expect(result.isError).toBe(false);
      expect(result.structuredContent).toMatchObject({
        task: { taskId: task.taskId, waitingForApproval: null, approvalsMode: "skip" },
      });

      const status = yield* call("computer_status", {});
      expect(status.structuredContent).toMatchObject({
        approvals: [],
        tasks: [{ taskId: task.taskId, waitingForApproval: null, approvalsMode: "skip" }],
        hosts: [{ busyTaskId: task.taskId }],
      });
    }).pipe(Effect.scoped, Effect.provide(layerTest({ computerApprovals: "skip" }))),
  );

  it.effect("computer_status names the hosts, the task's thread and the pending tap", () =>
    Effect.gen(function* () {
      const host = yield* startHost;
      const use = yield* call("computer_use", { goal: "read the draft" }).pipe(Effect.forkScoped);
      const task = yield* taskWhere((candidate) => candidate.kind === "use");
      yield* host
        .authorize({ taskId: task.taskId, step: 1, action: click("Send") })
        .pipe(Effect.forkScoped);
      yield* Fiber.join(use);

      const status = yield* call("computer_status", {});
      expect(status.isError).toBe(false);
      expect(status.structuredContent).toMatchObject({
        hosts: [{ name: "JJ's MacBook", busyTaskId: task.taskId }],
        tasks: [{ taskId: task.taskId, threadId, requester: `agent: ${providerInstanceId}` }],
        approvals: [
          {
            taskId: task.taskId,
            threadId,
            app: "Messages",
            title: "Dana",
            why: expect.stringContaining("sending or posting"),
          },
        ],
      });
    }).pipe(Effect.scoped, Effect.provide(layerTest())),
  );

  it.effect("computer_stop ends the task, and status returns what is left", () =>
    Effect.gen(function* () {
      const host = yield* startHost;
      const use = yield* call("computer_use", { goal: "read the draft" }).pipe(Effect.forkScoped);
      const task = yield* taskWhere((candidate) => candidate.kind === "use");
      yield* host.step({ taskId: task.taskId, text: "read the draft" });
      yield* Fiber.join(use);

      const stopped = yield* call("computer_stop", {});
      expect(stopped.isError).toBe(false);
      expect(stopped.structuredContent).toMatchObject({
        tasks: [{ taskId: task.taskId, status: "stopped", reason: "You stopped it." }],
        hosts: [{ busyTaskId: null }],
      });
    }).pipe(Effect.scoped, Effect.provide(layerTest())),
  );

  it.effect("maps a service refusal to the result the agent reads", () =>
    Effect.gen(function* () {
      // No host is connected: the service's own sentence names what to do about it.
      const status = yield* call("computer_status", {});
      expect(status.isError).toBe(false);
      expect(status.structuredContent).toEqual({ hosts: [], tasks: [], approvals: [] });

      const control = yield* call("computer_control", { kind: "open_app", app: "Safari" });
      expect(control.isError).toBe(true);
      expect(textOf(control)).toContain("No computer is connected to this environment.");
    }).pipe(Effect.scoped, Effect.provide(layerTest())),
  );

  it.effect("refuses a call without a goal, and answers without a decision", () =>
    Effect.gen(function* () {
      yield* startHost;
      const neither = yield* call("computer_use", {});
      expect(neither.isError).toBe(true);
      expect(textOf(neither)).toContain("Give `goal` to start a task");

      const unknown = yield* call("computer_use", { taskId: "cu_missing" });
      expect(unknown.isError).toBe(true);
      expect(textOf(unknown)).toContain("That task is not known here.");

      const answersOnly = yield* call("computer_use", {
        taskId: "cu_missing",
        answers: { next: { choice: "c0", confidence: "high" } },
      });
      expect(answersOnly.isError).toBe(true);
      expect(textOf(answersOnly)).toContain("Pass the `decisionId`");
    }).pipe(Effect.scoped, Effect.provide(layerTest())),
  );

  it.effect("a task that reports a step returns as running instead of holding the call", () =>
    Effect.gen(function* () {
      const host = yield* startHost;
      const use = yield* call("computer_use", { goal: "scroll the list" }).pipe(Effect.forkScoped);
      const task = yield* taskWhere((candidate) => candidate.kind === "use");
      yield* host.step({ taskId: task.taskId, text: "scrolled the list" });

      const result = yield* Fiber.join(use);
      expect(result.isError).toBe(false);
      expect(result.structuredContent).toMatchObject({
        task: {
          status: "running",
          pendingDecision: null,
          waitingForApproval: null,
          steps: ["scrolled the list"],
        },
        next: "It is still running. Call computer_status to follow it.",
      });
    }).pipe(Effect.scoped, Effect.provide(layerTest())),
  );

  it.effect("a denied step ends the task blocked and starts no second task", () =>
    Effect.gen(function* () {
      const service = yield* ComputerService.ComputerService;
      const host = yield* startHost;
      const use = yield* call("computer_use", { goal: "send the reply" }).pipe(Effect.forkScoped);
      const task = yield* taskWhere((candidate) => candidate.kind === "use");
      const tap = yield* host
        .authorize({ taskId: task.taskId, step: 1, action: click("Send") })
        .pipe(Effect.forkScoped);
      const pending = yield* call("computer_status", {});
      const approvalId = (
        pending.structuredContent as { approvals: ReadonlyArray<{ approvalId: string }> }
      ).approvals[0]!.approvalId;
      const result = yield* Fiber.join(use);
      yield* service.respondToApproval({
        approvalId,
        approve: false,
        decidedBy: "client:web",
      });
      yield* Fiber.join(tap);

      const ended = yield* call("computer_status", {});
      expect(ended.structuredContent).toMatchObject({
        tasks: [{ taskId: task.taskId, status: "blocked", waitingForApproval: null }],
        approvals: [],
      });
      expect((yield* service.status(null)).tasks).toHaveLength(1);
      expect(yield* Ref.get(host.starts)).toHaveLength(1);
      // The start's own result was the tap it waited on; the end is what status reports.
      expect(textOf(result)).toContain("You cannot approve it");
    }).pipe(Effect.scoped, Effect.provide(layerTest())),
  );
});
