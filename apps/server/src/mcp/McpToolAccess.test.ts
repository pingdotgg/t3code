import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpFailure,
  ProviderInstanceId,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { McpSchema, McpServer, Tool, Toolkit } from "effect/ai";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";

import { OrchestratorProjectionError } from "../orchestration-v2/Orchestrator.ts";
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpToolAccess from "./McpToolAccess.ts";
import { liveThreadShell, makeAskedThread } from "./McpToolAccess.testkit.ts";

const supervisedThreadId = ThreadId.make("thread:supervised");
const planThreadId = ThreadId.make("thread:plan");
const fullAccessThreadId = ThreadId.make("thread:full-access");
const endedThreadId = ThreadId.make("thread:ended");
const backgroundThreadId = ThreadId.make("thread:background");
const oldProviderThreadId = ThreadId.make("thread:old-provider-background");
const archivedThreadId = ThreadId.make("thread:archived-background");
const unknownOwnerThreadId = ThreadId.make("thread:unknown-background-owner");

const backgroundShell = (threadId: ThreadId, providerInstanceId: ProviderInstanceId) => ({
  ...liveThreadShell(threadId, { activeRunId: null }),
  pendingBackgroundTasks: [
    { taskId: "task:background", kind: "subagent" as const, providerInstanceId },
  ],
});

const shells = new Map([
  [supervisedThreadId, liveThreadShell(supervisedThreadId, { runtimeMode: "approval-required" })],
  [
    planThreadId,
    liveThreadShell(planThreadId, { runtimeMode: "approval-required", interactionMode: "plan" }),
  ],
  [fullAccessThreadId, liveThreadShell(fullAccessThreadId)],
  [endedThreadId, liveThreadShell(endedThreadId, { activeRunId: null })],
  [backgroundThreadId, backgroundShell(backgroundThreadId, ProviderInstanceId.make("codex"))],
  [oldProviderThreadId, backgroundShell(oldProviderThreadId, ProviderInstanceId.make("claude"))],
  [
    archivedThreadId,
    {
      ...backgroundShell(archivedThreadId, ProviderInstanceId.make("codex")),
      archivedAt: liveThreadShell(archivedThreadId).updatedAt,
    },
  ],
  [
    unknownOwnerThreadId,
    {
      ...liveThreadShell(unknownOwnerThreadId, { activeRunId: null }),
      pendingBackgroundTasks: [{ taskId: "task:unknown", kind: "subagent" as const }],
    },
  ],
]);

const threadCaller = (threadId: ThreadId): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: `provider:${threadId}`,
  thread: {
    threadId,
    providerSessionId: `provider:${threadId}`,
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
});

const clientCaller = (
  access: McpInvocationContext.McpClientCaller["access"],
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: "client:session",
  thread: undefined,
  client: { sessionId: "session", label: "Claude Code", access },
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
});

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "mcp-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const probe = {
  success: Schema.Struct({ ran: Schema.String }),
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagement.ThreadManagementService,
  ],
};
const ProbeToolkit = Toolkit.make(
  Tool.make("reads", probe),
  Tool.make("reads_as_caller", probe).annotate(
    McpSchema.EnabledWhen,
    McpInvocationContext.hiddenFromOutsideClients,
  ),
  Tool.make("acts_as_caller", probe).annotate(
    McpSchema.EnabledWhen,
    McpInvocationContext.hiddenFromOutsideClients,
  ),
  Tool.make("writes", probe),
  Tool.make("writes_with_capability", probe),
  Tool.make("writes_threads", {
    ...probe,
    parameters: Schema.Struct({ threadId: Schema.optional(ThreadId) }),
  }),
  Tool.make("starts_threads", {
    ...probe,
    parameters: Schema.Struct({
      runtimeMode: Schema.optional(RuntimeMode),
      interactionMode: Schema.optional(ProviderInteractionMode),
    }),
  }),
  Tool.make("writes_environment", probe),
  Tool.make("writes_owner_work", probe),
);
const ran = Effect.succeed({ ran: "ran" });
const probeHandlers: McpToolAccess.Handlers<typeof ProbeToolkit.tools> = {
  reads: McpToolAccess.reads(() => ran),
  reads_as_caller: McpToolAccess.readsAsCaller(() => ran),
  acts_as_caller: McpToolAccess.actsAsCaller(() => ran),
  writes: McpToolAccess.writes(() => ran),
  writes_with_capability: McpToolAccess.writesWithCapability(() => ran),
  writes_threads: McpToolAccess.writesThreads(
    (input) => [input.threadId],
    () => ran,
  ),
  starts_threads: McpToolAccess.startsThreads(
    (input) => input,
    (_, modes) => Effect.succeed({ ran: `${modes.runtimeMode}/${modes.interactionMode}` }),
    "stamped",
  ),
  writes_environment: McpToolAccess.writesEnvironment(() => ran),
  writes_owner_work: McpToolAccess.writesOwnerWork("drive owner work", () => ran),
};
const layerProbeHandlers = McpToolAccess.toLayer(ProbeToolkit, probeHandlers);

const unchecked = () => ran;

// `@ts-expect-error` fails the build if one ever compiles. Never called.
export const refusedAtCompileTime = () => {
  McpToolAccess.toLayer(ProbeToolkit, {
    ...probeHandlers,
    // @ts-expect-error a handler that skips its declaration
    reads: unchecked,
  });
  McpToolAccess.toLayer(ProbeToolkit, {
    ...probeHandlers,
    // @ts-expect-error a declaration's fields copied onto an unchecked handler
    reads: Object.assign(
      unchecked,
      McpToolAccess.reads(() => ran),
    ),
  });
  // @ts-expect-error a declaration built outside McpToolAccess
  McpToolAccess.Declaration.make(unchecked);
  // @ts-expect-error a declaration constructed directly
  new McpToolAccess.Declaration(unchecked); // oxlint-disable-line eslint/no-new -- This type-contract test checks direct construction.
  // @ts-expect-error a handlers layer built outside McpToolAccess
  McpToolAccess.HandlersLayer.make(Layer.empty);
  // @effect-diagnostics-next-line anyUnknownInErrorContext:off
  McpHttpServer.toolkitRegistration(
    ProbeToolkit,
    // @ts-expect-error a handlers layer that skipped `McpToolAccess.toLayer`
    ProbeToolkit.toLayer({
      reads: unchecked,
      reads_as_caller: unchecked,
      acts_as_caller: unchecked,
      writes: unchecked,
      writes_with_capability: unchecked,
      writes_threads: unchecked,
      starts_threads: unchecked,
      writes_environment: unchecked,
      writes_owner_work: unchecked,
    }),
  );
};

const probeServer = (threads: Layer.Layer<ThreadManagement.ThreadManagementService>) =>
  McpHttpServer.toolkitRegistration(ProbeToolkit, layerProbeHandlers).pipe(
    Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
    Layer.provideMerge(threads),
  );

const decodeOutcome = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Union([Schema.Struct({ ran: Schema.String }), Schema.Struct({ code: Schema.String })]),
  ),
);

const call = (
  tool: string,
  scope: McpInvocationContext.McpInvocationScope,
  args: Record<string, unknown> = {},
) =>
  McpServer.McpServer.pipe(
    Effect.flatMap((server) => server.callTool({ name: tool, arguments: args })),
    Effect.flatMap(({ content }) =>
      decodeOutcome(content.map((part) => (part.type === "text" ? part.text : "")).join("")),
    ),
    Effect.map((outcome) => ("code" in outcome ? outcome.code : outcome.ran)),
    Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
    Effect.provideService(McpSchema.McpServerClient, mcpClient),
  );

const supervised = threadCaller(supervisedThreadId);
const plan = threadCaller(planThreadId);
const fullAccess = threadCaller(fullAccessThreadId);
const ended = threadCaller(endedThreadId);
const background = threadCaller(backgroundThreadId);
const oldProviderBackground = threadCaller(oldProviderThreadId);
const archivedBackground = threadCaller(archivedThreadId);
const unknownOwnerBackground = threadCaller(unknownOwnerThreadId);
const mismatchedProvider = {
  ...background,
  thread: { ...background.thread!, providerInstanceId: ProviderInstanceId.make("claude") },
};
const supervisedClient = clientCaller("approval-required");
const fullAccessClient = clientCaller("full-access");
const readOnlyClient = clientCaller("read-only");
const linkedClient: McpInvocationContext.McpInvocationScope = {
  ...supervisedClient,
  client: { ...supervisedClient.client!, linked: true },
};
// A full-access link's agents can do anything this environment's user can.
const fullAccessLinkedClient: McpInvocationContext.McpInvocationScope = {
  ...fullAccessClient,
  client: { ...fullAccessClient.client!, linked: true },
};
// An administrator's ceiling narrows every client to it.
const atCeilingClient: McpInvocationContext.McpInvocationScope = {
  ...fullAccessClient,
  runtimeModeCeiling: "auto",
  client: {
    ...fullAccessClient.client!,
    narrowedTo: { runtimeMode: "auto", interactionMode: "default" },
  },
};
const previewOnly = { ...fullAccess, capabilities: new Set(["preview"] as const) };

it.effect.each([
  ["reads", ended, {}, "ran"],
  ["reads", supervisedClient, {}, "ran"],
  ["reads", readOnlyClient, {}, "ran"],

  ["writes", readOnlyClient, {}, "capability_denied"],
  ["writes_threads", readOnlyClient, { threadId: supervisedThreadId }, "capability_denied"],
  ["starts_threads", readOnlyClient, {}, "capability_denied"],
  ["writes_environment", readOnlyClient, {}, "capability_denied"],

  ["reads_as_caller", ended, {}, "ran"],
  ["acts_as_caller", supervised, {}, "ran"],
  ["acts_as_caller", ended, {}, "parent_not_active"],
  ["acts_as_caller", background, {}, "ran"],
  ["acts_as_caller", oldProviderBackground, {}, "parent_not_active"],
  ["acts_as_caller", mismatchedProvider, {}, "parent_not_active"],
  ["acts_as_caller", archivedBackground, {}, "parent_not_active"],
  ["acts_as_caller", unknownOwnerBackground, {}, "parent_not_active"],

  ["writes", supervised, {}, "ran"],
  ["writes", ended, {}, "parent_not_active"],
  ["writes", background, {}, "ran"],
  ["writes", oldProviderBackground, {}, "parent_not_active"],
  ["writes", supervisedClient, {}, "ran"],
  ["writes", previewOnly, {}, "capability_denied"],
  ["writes_environment", previewOnly, {}, "capability_denied"],

  ["writes_with_capability", previewOnly, {}, "ran"],
  ["writes_with_capability", readOnlyClient, {}, "capability_denied"],
  ["writes_with_capability", ended, {}, "parent_not_active"],
  ["writes", linkedClient, {}, "capability_denied"],
  ["writes_with_capability", linkedClient, {}, "capability_denied"],
  ["writes", fullAccessLinkedClient, {}, "ran"],
  ["writes_with_capability", fullAccessLinkedClient, {}, "ran"],

  ["writes_threads", supervised, {}, "ran"],
  ["writes_threads", supervised, { threadId: planThreadId }, "ran"],
  [
    "writes_threads",
    supervised,
    { threadId: fullAccessThreadId },
    "runtime_mode_escalation_denied",
  ],
  ["writes_threads", plan, { threadId: supervisedThreadId }, "interaction_mode_escalation_denied"],
  ["writes_threads", fullAccess, { threadId: supervisedThreadId }, "ran"],
  ["writes_threads", ended, { threadId: supervisedThreadId }, "parent_not_active"],
  ["writes_threads", supervisedClient, { threadId: supervisedThreadId }, "ran"],
  [
    "writes_threads",
    supervisedClient,
    { threadId: fullAccessThreadId },
    "runtime_mode_escalation_denied",
  ],
  ["writes_threads", supervised, { threadId: "thread:missing" }, "ran"],

  ["starts_threads", supervised, {}, "approval-required/default"],
  ["starts_threads", supervised, { runtimeMode: "full-access" }, "runtime_mode_escalation_denied"],
  ["starts_threads", plan, {}, "approval-required/plan"],
  ["starts_threads", plan, { interactionMode: "default" }, "interaction_mode_escalation_denied"],
  ["starts_threads", fullAccess, { runtimeMode: "auto", interactionMode: "plan" }, "auto/plan"],
  ["starts_threads", ended, {}, "parent_not_active"],
  ["starts_threads", supervisedClient, {}, "approval-required/default"],
  ["starts_threads", supervisedClient, { runtimeMode: "auto" }, "runtime_mode_escalation_denied"],
  ["starts_threads", fullAccessClient, { runtimeMode: "full-access" }, "full-access/default"],

  ["writes_environment", fullAccess, {}, "ran"],
  ["writes_environment", supervised, {}, "capability_denied"],
  ["writes_environment", plan, {}, "capability_denied"],
  ["writes_environment", fullAccessClient, {}, "ran"],
  ["writes_environment", supervisedClient, {}, "capability_denied"],

  ["writes_owner_work", fullAccess, {}, "ran"],
  ["writes_owner_work", supervised, {}, "capability_denied"],
  ["writes_owner_work", plan, {}, "capability_denied"],
  ["writes_owner_work", ended, {}, "parent_not_active"],
  ["writes_owner_work", fullAccessClient, {}, "ran"],
  ["writes_owner_work", supervisedClient, {}, "capability_denied"],
  ["writes_owner_work", readOnlyClient, {}, "capability_denied"],
  ["writes_owner_work", linkedClient, {}, "capability_denied"],
  ["writes_owner_work", fullAccessLinkedClient, {}, "ran"],
  ["writes_owner_work", atCeilingClient, {}, "ran"],
  ["writes_environment", atCeilingClient, {}, "capability_denied"],
] as const)("%s from %o with %o: %s", ([tool, scope, args, expected]) =>
  call(tool, scope, args).pipe(
    Effect.map((outcome) => expect(outcome).toBe(expected)),
    Effect.provide(
      probeServer(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: (threadId) => Effect.succeed(shells.get(threadId) ?? null),
        }),
      ),
    ),
  ),
);

it("refuses a declaration or handlers layer that only wears another's fields", () => {
  const copiedDeclaration = Object.assign(
    unchecked,
    McpToolAccess.reads(() => ran),
  );
  expect(() =>
    McpToolAccess.toLayer(ProbeToolkit, {
      ...probeHandlers,
      // @ts-expect-error a declaration's fields copied onto an unchecked handler
      reads: copiedDeclaration,
    }),
  ).toThrow(TypeError);
  const copiedLayer = Object.assign(Layer.empty, layerProbeHandlers);
  expect(() => McpToolAccess.HandlersLayer.layer(copiedLayer)).toThrow(TypeError);
});

it.effect("refuses a change when the calling thread cannot be read", () =>
  call("writes", supervised).pipe(
    Effect.map((outcome) => expect(outcome).toBe("orchestration_error")),
    Effect.provide(
      probeServer(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: (threadId) =>
            Effect.fail(new OrchestratorProjectionError({ threadId, cause: "unreadable" })),
        }),
      ),
    ),
  ),
);

const box = EnvironmentId.make("environment-box");
const here = EnvironmentId.make("environment");
const linkedProbe = {
  ...probe,
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    threadId: Schema.optional(ThreadId),
    runtimeMode: Schema.optional(RuntimeMode),
    interactionMode: Schema.optional(ProviderInteractionMode),
  }),
};
const LinkedProbeToolkit = Toolkit.make(
  Tool.make("reads", linkedProbe),
  Tool.make("writes", linkedProbe),
  Tool.make("writes_with_capability", linkedProbe),
  Tool.make("writes_threads", linkedProbe),
  Tool.make("starts_threads", linkedProbe),
  Tool.make("writes_environment", linkedProbe),
);
/** Runs here, and tells whether `environmentId` reached the handler. */
const ranHere = <P extends object>(params: P) =>
  Effect.succeed({ ran: "environmentId" in params ? "saw environmentId" : "here" });

const linkedProbeServer = McpHttpServer.toolkitRegistration(
  LinkedProbeToolkit,
  McpToolAccess.toLayer(LinkedProbeToolkit, {
    reads: McpToolAccess.reads(ranHere),
    writes: McpToolAccess.writes(ranHere),
    writes_with_capability: McpToolAccess.writesWithCapability(ranHere),
    writes_threads: McpToolAccess.writesThreads((input) => [input.threadId], ranHere),
    starts_threads: McpToolAccess.startsThreads((input) => input, ranHere, "stamped"),
    writes_environment: McpToolAccess.writesEnvironment(ranHere),
  }),
).pipe(
  Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
  Layer.provideMerge(
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (threadId) => Effect.succeed(shells.get(threadId) ?? null),
    }),
  ),
  // Stands in for the linked environment, answering with where the call went.
  Layer.provide(
    Layer.mock(PeerForwarding.PeerForwarding)({
      call: (_scope, tool, environmentId) =>
        Effect.succeed({ ran: `${tool.name} in ${environmentId}` } as never),
    }),
  ),
);

it.effect.each([
  ["reads", supervised, { environmentId: box }, "reads in environment-box"],
  ["reads", supervised, { environmentId: here }, "here"],
  ["reads", supervised, {}, "here"],

  // The caller is checked here before anything goes.
  ["writes", readOnlyClient, { environmentId: box }, "capability_denied"],
  ["writes", ended, { environmentId: box }, "parent_not_active"],
  ["writes", supervised, { environmentId: box }, "writes in environment-box"],
  ["writes_with_capability", readOnlyClient, { environmentId: box }, "capability_denied"],
  [
    "starts_threads",
    plan,
    { environmentId: box, interactionMode: "default" },
    "interaction_mode_escalation_denied",
  ],
  ["starts_threads", plan, { environmentId: box }, "starts_threads in environment-box"],
  ["writes_environment", supervised, { environmentId: box }, "capability_denied"],
  [
    "writes_environment",
    fullAccess,
    { environmentId: box },
    "writes_environment in environment-box",
  ],
  ["writes_environment", fullAccess, { environmentId: here }, "here"],

  // A thread id names a thread where the call runs, and is checked there.
  [
    "writes_threads",
    supervised,
    { environmentId: box, threadId: fullAccessThreadId },
    "writes_threads in environment-box",
  ],
  [
    "writes_threads",
    supervised,
    { environmentId: here, threadId: fullAccessThreadId },
    "runtime_mode_escalation_denied",
  ],
] as const)("a linked %s from %o with %o: %s", ([tool, scope, args, expected]) =>
  call(tool, scope, args).pipe(
    Effect.map((outcome) => expect(outcome).toBe(expected)),
    Effect.provide(linkedProbeServer),
  ),
);

it.effect("refuses a linked environment to a tool that acts as its calling thread", () =>
  Effect.gen(function* () {
    const CallerToolkit = Toolkit.make(
      Tool.make("acts_as_caller", linkedProbe).annotate(
        McpSchema.EnabledWhen,
        McpInvocationContext.hiddenFromOutsideClients,
      ),
    );
    const built = yield* Layer.build(
      McpToolAccess.HandlersLayer.layer(
        McpToolAccess.toLayer(CallerToolkit, {
          acts_as_caller: McpToolAccess.actsAsCaller(ranHere),
        }),
      ),
    ).pipe(Effect.scoped, Effect.exit);
    expect(Exit.isFailure(built) && Cause.hasDies(built.cause)).toBe(true);
  }),
);

// Discovery hides these tools. The handler must refuse on its own if that ever changes.
it.effect.each(["reads_as_caller", "acts_as_caller"] as const)(
  "%s refuses an outside client behind discovery",
  (tool) =>
    Effect.gen(function* () {
      const built = yield* ProbeToolkit;
      const { result } = yield* built
        .handle(tool, {})
        .pipe(Stream.unwrap, Stream.run(Sink.last()), Effect.flatMap(Effect.fromOption));
      expect(result).toMatchObject({ code: "thread_credential_required" });
    }).pipe(
      Effect.provide(McpToolAccess.HandlersLayer.layer(layerProbeHandlers)),
      Effect.provideService(McpInvocationContext.McpInvocationContext, fullAccessClient),
      Effect.provide(Layer.mock(ThreadManagement.ThreadManagementService)({})),
    ),
);

it.effect("refuses to build a thread-bound tool that outside clients would be offered", () =>
  Effect.gen(function* () {
    const CallerToolkit = Toolkit.make(Tool.make("reads_as_caller", probe));
    const built = yield* Layer.build(
      McpToolAccess.HandlersLayer.layer(
        McpToolAccess.toLayer(CallerToolkit, {
          reads_as_caller: McpToolAccess.readsAsCaller(() => ran),
        }),
      ),
    ).pipe(Effect.scoped, Effect.exit);
    expect(Exit.isFailure(built) && Cause.pretty(built.cause)).toContain(
      "reads_as_caller acts as its calling thread",
    );
  }),
);

const MERGE_FIVE: McpToolAccess.OutsideAction = {
  action: "Merge",
  target: "pull request #5",
  repository: "org/repo",
};

type Outcome = { readonly ran?: string; readonly code?: string; readonly message?: string };

/**
 * A tool that acts outside its thread, a person to answer what it asks, and a linked
 * environment `there` that runs the same tool for calls sent to it.
 */
const outsideProbe = Effect.fn("outsideProbe")(function* (
  asks: () => McpToolAccess.OutsideAction = () => MERGE_FIVE,
  options: Parameters<typeof makeAskedThread>[0] & {
    /** What the linked environment resolves the call to; this one's `asks` when omitted. */
    readonly asksThere?: () => McpToolAccess.OutsideAction;
  } = {},
) {
  const thread = yield* makeAskedThread(options);
  const ran: Array<string> = [];
  const sent: Array<McpToolAccess.LinkedOutsideAction | undefined> = [];
  const OutsideToolkit = Toolkit.make(Tool.make("acts_outside", linkedProbe));
  const build = (
    where: string,
    resolved: () => McpToolAccess.OutsideAction,
    forwarding: Layer.Layer<PeerForwarding.PeerForwarding>,
  ) =>
    OutsideToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(
          McpToolAccess.toLayer(OutsideToolkit, {
            acts_outside: McpToolAccess.actsOutsideThread("acts_outside", () =>
              Effect.succeed({
                asks: resolved(),
                run: Effect.sync(() => {
                  ran.push(where);
                  return { ran: where };
                }),
              }),
            ),
          }),
        ).pipe(Layer.provide(forwarding)),
      ),
    );
  const handle = (
    toolkit: Effect.Success<ReturnType<typeof build>>,
    scope: McpInvocationContext.McpInvocationScope,
    args: { readonly environmentId?: EnvironmentId },
  ) =>
    toolkit.handle("acts_outside", args).pipe(
      Stream.unwrap,
      Stream.run(Sink.last()),
      Effect.flatMap(Effect.fromOption),
      Effect.map(({ result }) => result as Outcome),
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
      thread.provide,
      Effect.provide(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          ...thread.threads,
          getThreadShell: (threadId) => Effect.succeed(shells.get(threadId) ?? null),
        }),
      ),
      Effect.orDie,
    );
  // The linked environment: the same tool, called by this one's link with the caller's modes.
  const there = yield* build(
    "there",
    options.asksThere ?? asks,
    Layer.mock(PeerForwarding.PeerForwarding)({}),
  );
  const toolkit = yield* build(
    "here",
    asks,
    Layer.mock(PeerForwarding.PeerForwarding)({
      label: () => Effect.succeed("Box"),
      call: (scope, _tool, _environmentId, _params, outsideAction) =>
        Effect.gen(function* () {
          sent.push(outsideAction);
          const limits = scope.thread === undefined ? undefined : shells.get(scope.thread.threadId);
          const result = yield* handle(
            there,
            {
              ...fullAccessLinkedClient,
              client: {
                ...fullAccessLinkedClient.client!,
                narrowedTo: {
                  runtimeMode: limits?.runtimeMode ?? "full-access",
                  interactionMode: limits?.interactionMode ?? "default",
                },
              },
              outsideAction,
            },
            {},
          );
          return result.code === undefined
            ? (result as never)
            : yield* new OrchestratorMcpFailure({
                code: result.code as "capability_denied",
                message: result.message ?? "",
              });
        }),
    }),
  );
  return {
    ...thread,
    ran,
    sent,
    call: (
      scope: McpInvocationContext.McpInvocationScope,
      args: { readonly environmentId?: EnvironmentId } = {},
    ) => handle(toolkit, scope, args),
  };
});

const QUESTION = /^Merge pull request #5 in org\/repo\? \(request [0-9a-f]{8}\)$/;

it.effect(
  "below Full access the person is asked in the thread, and one approval lets one call through",
  () =>
    Effect.gen(function* () {
      const probed = yield* outsideProbe();
      const call = yield* Effect.forkChild(probed.call(supervised));
      const asked = yield* probed.asked;
      expect(asked.message).toMatch(QUESTION);
      expect(asked.toolAction).toEqual({ tool: "acts_outside", ...MERGE_FIVE });
      // The client is sent the same request, named by the id the thread's adapter reads.
      yield* Effect.yieldNow;
      expect(yield* probed.elicited).toEqual([
        {
          message: asked.message,
          meta: {
            "t3.codes/approval-request": asked.id,
            "anthropic/permissionDisplay": { description: asked.id },
          },
        },
      ]);
      expect(probed.ran).toEqual([]);

      yield* probed.answer(asked, "accept");
      expect(yield* Fiber.join(call)).toEqual({ ran: "here" });
      expect(probed.ran).toEqual(["here"]);

      // The approval is spent: the same call asks again.
      const again = yield* Effect.forkChild(probed.call(supervised));
      const second = yield* probed.asked;
      expect(second.id).not.toBe(asked.id);
      yield* probed.answer(second, "decline");
      expect(yield* Fiber.join(again)).toMatchObject({
        code: "capability_denied",
        message: 'Not done: the user declined "Merge pull request #5 in org/repo".',
      });
      expect(probed.ran).toEqual(["here"]);
    }).pipe(Effect.provide(McpProviderSessions.layer)),
);

it.effect("the call waits for the person with no limit of its own", () =>
  Effect.gen(function* () {
    const probed = yield* outsideProbe();
    const call = yield* Effect.forkChild(probed.call(supervised));
    const asked = yield* probed.asked;
    yield* TestClock.adjust("12 hours");
    expect(yield* probed.pending).toHaveLength(1);
    expect(probed.ran).toEqual([]);
    yield* probed.answer(asked, "accept");
    expect(yield* Fiber.join(call)).toEqual({ ran: "here" });
  }).pipe(Effect.provide(McpProviderSessions.layer)),
);

const CANCELLED =
  'Cancelled, nothing was done: the request to approve "Merge pull request #5 in org/repo" ended without the user\'s answer. They dismissed it, or the turn ended or was interrupted. Ask the user before trying again.';

it.effect.each([
  ["the turn ends", "completed"],
  ["the turn is interrupted", "interrupted"],
] as const)("when %s the request is cancelled and nothing is done", ([, status]) =>
  Effect.gen(function* () {
    const probed = yield* outsideProbe();
    const call = yield* Effect.forkChild(probed.call(supervised));
    yield* probed.asked;
    yield* probed.endTurn(status);
    expect(yield* Fiber.join(call)).toMatchObject({
      code: "capability_denied",
      message: CANCELLED,
    });
    expect(yield* probed.pending).toEqual([]);
    expect((yield* probed.raised).map((request) => request.status)).toEqual(["cancelled"]);
    expect(probed.ran).toEqual([]);
  }).pipe(Effect.provide(McpProviderSessions.layer)),
);

it.effect("a request the person dismisses, or the client stops waiting on, is cancelled", () =>
  Effect.gen(function* () {
    const probed = yield* outsideProbe();
    const dismissed = yield* Effect.forkChild(probed.call(supervised));
    yield* probed.answer(yield* probed.asked, "cancel");
    expect(yield* Fiber.join(dismissed)).toMatchObject({ message: CANCELLED });

    const stopped = yield* Effect.forkChild(probed.call(supervised));
    yield* probed.asked;
    yield* probed.clientStopsWaiting;
    expect(yield* Fiber.join(stopped)).toMatchObject({ message: CANCELLED });
    expect(yield* probed.pending).toEqual([]);
    expect(probed.ran).toEqual([]);
  }).pipe(Effect.provide(McpProviderSessions.layer)),
);

it.effect(
  "a call that is cut off leaves the request, and the same call again finds the answer",
  () =>
    Effect.gen(function* () {
      const probed = yield* outsideProbe();
      const cut = yield* Effect.forkChild(probed.call(supervised));
      const asked = yield* probed.asked;
      yield* Fiber.interrupt(cut);
      expect(yield* probed.pending).toHaveLength(1);
      yield* probed.answer(asked, "accept");
      // The same call in the same turn: no second request, and the answer already given.
      expect(yield* probed.call(supervised)).toEqual({ ran: "here" });
      expect(yield* probed.raised).toHaveLength(1);
    }).pipe(Effect.provide(McpProviderSessions.layer)),
);

it.effect.each([
  ["whose adapter does not hold T3 Code's requests", { held: false }],
  ["whose client takes no elicitation", { elicitation: false }],
] as const)("a thread %s is told so, and nothing is shown or done", ([, options]) =>
  Effect.gen(function* () {
    const probed = yield* outsideProbe(() => MERGE_FIVE, options);
    expect(yield* probed.call(supervised)).toMatchObject({
      code: "capability_denied",
      message:
        "Not done: \"Merge pull request #5 in org/repo\" needs the user's approval below Full access, and this agent's client cannot ask for it. Tell the user; they can do it themselves or switch this thread to Full access.",
    });
    expect(yield* probed.raised).toEqual([]);
    expect(probed.ran).toEqual([]);
  }).pipe(Effect.provide(McpProviderSessions.layer)),
);

it.effect(
  "a sessionless client is sent the request as its call's answer, and the call it makes next finds the person's answer",
  () =>
    Effect.gen(function* () {
      const probed = yield* outsideProbe(() => MERGE_FIVE, { sessionless: true });
      // The first call ends at once: its answer is the elicitation, which the client holds.
      yield* probed.call(supervised);
      const asked = yield* probed.asked;
      const elicitation = yield* probed.answeredWith;
      expect(elicitation?.requestState).toBe(asked.id);
      expect(elicitation?.inputRequests).toMatchObject({
        approval: {
          method: "elicitation/create",
          params: {
            mode: "form",
            message: asked.message,
            _meta: { "t3.codes/approval-request": asked.id },
          },
        },
      });
      expect(probed.ran).toEqual([]);

      // The person approves in the thread; the adapter then lets the client reply and call again.
      yield* probed.answer(asked, "accept");
      yield* Effect.yieldNow.pipe(Effect.repeat({ times: 20 }));
      yield* probed.repliesTo(asked.id);
      expect(yield* probed.call(supervised)).toEqual({ ran: "here" });
      expect(yield* probed.answeredWith).toBeUndefined();
      expect(yield* probed.raised).toHaveLength(1);

      // A client that replies "accept" by itself, with nothing answered in the thread, runs nothing.
      yield* probed.repliesTo(undefined);
      yield* probed.call(supervised);
      const second = yield* probed.asked;
      yield* probed.repliesTo(second.id);
      expect(yield* probed.call(supervised)).toMatchObject({ code: "capability_denied" });
      expect(probed.ran).toEqual(["here"]);
    }).pipe(Effect.provide(McpProviderSessions.layer)),
);

it.effect("a thread with no turn running has nowhere to be asked", () =>
  Effect.gen(function* () {
    const probed = yield* outsideProbe();
    yield* probed.endTurn();
    expect(yield* probed.call(supervised)).toMatchObject({
      code: "capability_denied",
      message:
        'Not done: "Merge pull request #5 in org/repo" needs the user\'s approval below Full access, and T3 Code asks them in a turn of this thread, which has none running now. Call again during a turn.',
    });
    expect(yield* probed.raised).toEqual([]);
  }).pipe(Effect.provide(McpProviderSessions.layer)),
);

it.effect("an approval is for what the call resolved to, shown or not", () =>
  Effect.gen(function* () {
    let binds = "head-1";
    const probed = yield* outsideProbe(() => ({ ...MERGE_FIVE, binds }));
    const cut = yield* Effect.forkChild(probed.call(supervised));
    const asked = yield* probed.asked;
    yield* Fiber.interrupt(cut);
    yield* probed.answer(asked, "accept");
    // What the words do not carry changes while the person reads: the same words, another request.
    binds = "head-2";
    const moved = yield* Effect.forkChild(probed.call(supervised));
    const second = yield* probed.asked;
    expect(second.id).not.toBe(asked.id);
    expect(second.message).not.toBe(asked.message);
    expect(probed.ran).toEqual([]);
    yield* Fiber.interrupt(moved);
  }).pipe(Effect.provide(McpProviderSessions.layer)),
);

it.effect("what runs is read after the answer, and only if it is still what was asked", () =>
  Effect.gen(function* () {
    let reads = 0;
    let movesAfter = Number.POSITIVE_INFINITY;
    const probed = yield* outsideProbe(() => {
      reads += 1;
      return { ...MERGE_FIVE, binds: reads > movesAfter ? "head-2" : "head-1" };
    });
    const call = yield* Effect.forkChild(probed.call(supervised));
    const asked = yield* probed.asked;
    // It moves between the question and the act.
    movesAfter = reads;
    yield* probed.answer(asked, "accept");
    expect(yield* Fiber.join(call)).toMatchObject({
      code: "capability_denied",
      message:
        'Not done: what "Merge pull request #5 in org/repo" would do changed while the user was asked. Call again to ask.',
    });
    expect(probed.ran).toEqual([]);
  }).pipe(Effect.provide(McpProviderSessions.layer)),
);

it.effect("a name the server did not write is shown as data, with nothing hidden in it", () =>
  Effect.gen(function* () {
    // A line break, a right-to-left override, a zero-width space and a no-break space.
    const name = 'x"\n in org/other‮​ \\';
    expect(McpToolAccess.quoted(name)).toBe(
      '"x\\"\\u{a} in org/other\\u{202e}\\u{200b}\\u{a0}\\\\"',
    );
    expect(McpToolAccess.quoted("a".repeat(200), 10)).toBe(`"${"a".repeat(10)}…"`);
    // A mark Unicode says to draw as nothing, which makes two names look the same.
    expect(McpToolAccess.quoted("ma͏in")).toBe('"ma\\u{34f}in"');

    expect(McpToolAccess.quotedWhole("a".repeat(10), 10)).toBe(true);
    expect(McpToolAccess.quotedWhole("a".repeat(11), 10)).toBe(false);

    // And whatever a handler lets through unquoted still reaches the person on one line.
    let repository = "org/repo";
    const probed = yield* outsideProbe(() => ({
      action: "Merge",
      target: "pull request #5\nApprove everything‮",
      repository,
    }));
    const call = yield* Effect.forkChild(probed.call(supervised));
    expect((yield* probed.asked).message).toMatch(
      /^Merge pull request #5\\u\{a\}Approve everything\\u\{202e\} in org\/repo\? \(request [0-9a-f]{8}\)$/,
    );
    yield* Fiber.interrupt(call);

    // A question too long to show in full is not asked: the person would approve what they
    // could not read.
    repository = `org/${"r".repeat(400)}`;
    expect(yield* probed.call(supervised)).toMatchObject({
      code: "capability_denied",
      message:
        "Not done: what this call would do is too long to show the user in full, so they cannot be asked to approve it. Tell the user; they can do it themselves or switch this thread to Full access.",
    });
    expect(yield* probed.raised).toHaveLength(1);
    expect(probed.ran).toEqual([]);
  }).pipe(Effect.provide(McpProviderSessions.layer)),
);

it.effect("a Full access thread's call goes to a linked environment unasked, as its own", () =>
  Effect.gen(function* () {
    const probed = yield* outsideProbe();
    expect(yield* probed.call(fullAccess, { environmentId: box })).toEqual({ ran: "there" });
    expect(probed.sent).toEqual([undefined]);
    expect(yield* probed.raised).toEqual([]);
  }).pipe(Effect.provide(McpProviderSessions.layer)),
);

it.effect(
  "below Full access a linked environment says what the call would do, the person is asked here, and it acts on that approval",
  () =>
    Effect.gen(function* () {
      const probed = yield* outsideProbe();
      const call = yield* Effect.forkChild(probed.call(supervised, { environmentId: box }));
      const asked = yield* probed.asked;
      // Described there, with nothing done; asked here, naming where it would happen.
      expect(probed.sent).toEqual(["describe"]);
      expect(probed.ran).toEqual([]);
      expect(asked.message).toMatch(
        /^Merge pull request #5 \(in linked environment "Box"\) in org\/repo\? \(request [0-9a-f]{8}\)$/,
      );
      expect(asked.toolAction).toEqual({
        tool: "acts_outside",
        action: "Merge",
        target: 'pull request #5 (in linked environment "Box")',
        repository: "org/repo",
      });

      yield* probed.answer(asked, "accept");
      expect(yield* Fiber.join(call)).toEqual({ ran: "there" });
      expect(probed.sent).toEqual([
        "describe",
        { approved: expect.stringMatching(/^[0-9a-f]{64}$/) },
      ]);
      expect(probed.ran).toEqual(["there"]);
    }).pipe(Effect.provide(McpProviderSessions.layer)),
);

it.effect("a linked environment acts only if the call still resolves to what was approved", () =>
  Effect.gen(function* () {
    let head = "head-1";
    const probed = yield* outsideProbe(() => MERGE_FIVE, {
      asksThere: () => ({ ...MERGE_FIVE, binds: head }),
    });
    const call = yield* Effect.forkChild(probed.call(supervised, { environmentId: box }));
    const asked = yield* probed.asked;
    head = "head-2";
    yield* probed.answer(asked, "accept");
    expect(yield* Fiber.join(call)).toMatchObject({
      code: "capability_denied",
      message:
        'Not done: what "Merge pull request #5 in org/repo" would do changed while the user was asked. Call again to ask.',
    });
    expect(probed.ran).toEqual([]);
  }).pipe(Effect.provide(McpProviderSessions.layer)),
);

it.effect("a declined or cancelled request sends nothing more to the linked environment", () =>
  Effect.gen(function* () {
    const probed = yield* outsideProbe();
    const declined = yield* Effect.forkChild(probed.call(supervised, { environmentId: box }));
    yield* probed.answer(yield* probed.asked, "decline");
    expect(yield* Fiber.join(declined)).toMatchObject({
      message:
        'Not done: the user declined "Merge pull request #5 (in linked environment "Box") in org/repo".',
    });
    const cancelled = yield* Effect.forkChild(probed.call(supervised, { environmentId: box }));
    yield* probed.asked;
    yield* probed.endTurn("interrupted");
    expect((yield* Fiber.join(cancelled)).message).toMatch(/^Cancelled, nothing was done: /);
    expect(probed.sent).toEqual(["describe", "describe"]);
    expect(probed.ran).toEqual([]);
  }).pipe(Effect.provide(McpProviderSessions.layer)),
);

// A narrowed full-access link is a linked environment passing on its agent's modes, which are
// below Full access: there is no thread here to ask the person in.
const narrowedLinkedClient: McpInvocationContext.McpInvocationScope = {
  ...fullAccessLinkedClient,
  client: {
    ...fullAccessLinkedClient.client!,
    narrowedTo: { runtimeMode: "approval-required", interactionMode: "default" },
  },
};

it.effect.each([
  ["a full-access client", fullAccessClient, "here"],
  ["a full-access link", fullAccessLinkedClient, "here"],
  ["a client approved below full access", supervisedClient, "capability_denied"],
  ["a client held to an administrator's limit", atCeilingClient, "capability_denied"],
  ["a link passing on modes below full access", narrowedLinkedClient, "capability_denied"],
  ["a read-only client", readOnlyClient, "capability_denied"],
] as const)("%s has no thread to be asked in: %o", ([, scope, expected]) =>
  Effect.gen(function* () {
    const probed = yield* outsideProbe();
    const result = yield* probed.call(scope);
    expect(result.code ?? result.ran).toBe(expected);
    expect(yield* probed.raised).toEqual([]);
    expect(probed.ran).toEqual(expected === "here" ? ["here"] : []);
    if (expected !== "here" && scope !== readOnlyClient) {
      expect(result.message).toBe(
        'Not done: "Merge pull request #5 in org/repo" needs full access for this MCP client, which has no thread where a person could approve it.',
      );
    }
  }).pipe(Effect.provide(McpProviderSessions.layer)),
);

it.effect(
  "what a linked environment is told is read only from a link, and describing never acts",
  () =>
    Effect.gen(function* () {
      const probed = yield* outsideProbe();
      // A client that is not a link claims an approval: it is as if it had said nothing.
      const claimed = yield* probed.call({
        ...supervisedClient,
        outsideAction: { approved: "0".repeat(64) },
      });
      expect(claimed.message).toMatch(/needs full access for this MCP client/);
      // A link asked to describe only describes, even for a caller nobody needs to be asked for.
      const described = yield* probed.call({
        ...fullAccessLinkedClient,
        outsideAction: "describe",
      });
      expect(described.code).toBe("capability_denied");
      expect(described.message).toMatch(/^t3-outside-action-description \{/);
      // And an approval for another request is not this one's.
      const other = yield* probed.call({
        ...narrowedLinkedClient,
        outsideAction: { approved: "0".repeat(64) },
      });
      expect(other.message).toMatch(/changed while the user was asked/);
      expect(probed.ran).toEqual([]);
    }).pipe(Effect.provide(McpProviderSessions.layer)),
);
