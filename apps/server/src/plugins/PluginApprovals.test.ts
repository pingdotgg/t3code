import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  EventId,
  NodeId,
  PLUGIN_APPROVAL_LIMITS,
  PluginInstallation,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2RuntimeRequest,
  type PluginCatalogError,
  type ProviderRequestKind,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { userFacingDispatchErrorMessage } from "../orchestration-v2/UserFacingErrors.ts";
import * as PluginApprovals from "./PluginApprovals.ts";
import * as PluginCatalog from "./PluginCatalog.ts";
import { loadPluginDirectory } from "./PluginManifestLoader.ts";
import * as PluginSupervisor from "./PluginSupervisor.ts";

// Children run the real CLI entry, which routes `__plugin-host` to the child runtime.
const BIN_PATH = `${import.meta.dirname}/../bin.ts`;
const FIXTURE = `${import.meta.dirname}/testFixtures/approvalsPlugin`;

const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const environmentId = EnvironmentId.make("environment-approvals");
const projectId = ProjectId.make("project:approvals");
const threadId = ThreadId.make("thread:approvals");
const sessionId = ProviderSessionId.make("session:approvals");
const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process is needed to record answers"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

// A fresh database, orchestrator and event sink per test; no effect worker, so a recorded
// answer stays in the outbox instead of reaching a provider.
const orchestration = Layer.unwrap(
  Effect.sync(() => {
    const database = SqlitePersistence.layerMemory;
    return Layer.mergeAll(
      database,
      ProjectionStore.layer.pipe(Layer.provide(database)),
      ProviderReplayHarness.layerWithRegistry(
        { name: "plugin-approvals" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        { databaseLayer: database, runEffectWorker: false },
      ),
    );
  }),
);

type Receipt = PluginApprovals.PluginApprovalReceipt;
type Invoke = PluginCatalog.PluginCatalog["Service"]["invoke"];
type InvokeResult = ReturnType<Invoke>;

/** A thread in approval-required mode with a live Codex session. */
const createThread = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const sink = yield* EventSink.EventSinkV2;
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make("create-thread"),
    threadId,
    projectId,
    title: "Approvals",
    modelSelection: { instanceId, model: "gpt-6" },
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  const now = yield* DateTime.now;
  yield* sink.write({
    events: [
      {
        id: EventId.make("attach-session"),
        type: "provider-session.attached",
        threadId,
        occurredAt: now,
        payload: {
          id: sessionId,
          driver: adapter.driver,
          providerInstanceId: instanceId,
          status: "ready",
          cwd: "/repo",
          model: "gpt-6",
          capabilities: CodexProviderCapabilitiesV2,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        },
      },
    ],
  });
});

let ordinal = 0;

/** The approval card of the request `raise(name)` commits. */
const approvalCard = (
  name: string,
  prompt: string | undefined,
  kind: ProviderRequestKind,
  now: DateTime.Utc,
) => ({
  id: EventId.make(`item:${name}:${prompt?.length ?? "none"}`),
  type: "turn-item.updated" as const,
  threadId,
  occurredAt: now,
  payload: {
    id: TurnItemId.make(`item:${name}`),
    threadId,
    runId: null,
    nodeId: NodeId.make(`node:${name}`),
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: ++ordinal,
    status: "waiting" as const,
    title: null,
    startedAt: now,
    completedAt: null,
    updatedAt: now,
    type: "approval_request" as const,
    requestId: RuntimeRequestId.make(`request:${name}`),
    requestKind: kind,
    ...(prompt === undefined ? {} : { prompt }),
  },
});

/** Commits the card of a request raised without one, as Codex, Claude, ACP and OpenCode 2 do. */
const commitCard = Effect.fn("commitCard")(function* (
  name: string,
  prompt: string | undefined,
  kind: ProviderRequestKind = "command",
) {
  const sink = yield* EventSink.EventSinkV2;
  const now = yield* DateTime.now;
  yield* sink.write({ events: [approvalCard(name, prompt, kind, now)] });
});

/**
 * Commits a pending approval as an adapter does: its node, its card, then the
 * request. Without the card, only the node and the request.
 */
const raise = Effect.fn("raise")(function* (
  name: string,
  prompt: string,
  kind: ProviderRequestKind = "command",
  /** The command the approval is for, as a parent tool item the provider reported first. */
  command?: string,
  withCard = true,
) {
  const sink = yield* EventSink.EventSinkV2;
  const now = yield* DateTime.now;
  const requestId = RuntimeRequestId.make(`request:${name}`);
  const nodeId = NodeId.make(`node:${name}`);
  const toolNodeId = NodeId.make(`tool:${name}`);
  const node = {
    threadId,
    runId: null,
    status: "waiting",
    countsForRun: false,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    checkpointScopeId: null,
    startedAt: now,
    completedAt: null,
  } as const;
  yield* sink.write({
    events: [
      ...(command === undefined
        ? []
        : [
            {
              id: EventId.make(`tool-node:${name}`),
              type: "node.updated" as const,
              threadId,
              occurredAt: now,
              payload: {
                ...node,
                id: toolNodeId,
                parentNodeId: null,
                rootNodeId: toolNodeId,
                kind: "tool_call" as const,
                runtimeRequestId: null,
              },
            },
            {
              id: EventId.make(`tool-item:${name}`),
              type: "turn-item.updated" as const,
              threadId,
              occurredAt: now,
              payload: {
                id: TurnItemId.make(`tool-item:${name}`),
                threadId,
                runId: null,
                nodeId: toolNodeId,
                providerThreadId: null,
                providerTurnId: null,
                nativeItemRef: null,
                parentItemId: null,
                ordinal: ++ordinal,
                status: "waiting" as const,
                title: null,
                startedAt: now,
                completedAt: null,
                updatedAt: now,
                type: "command_execution" as const,
                input: command,
              },
            },
          ]),
      {
        id: EventId.make(`node:${name}`),
        type: "node.updated",
        threadId,
        occurredAt: now,
        payload: {
          ...node,
          id: nodeId,
          parentNodeId: command === undefined ? null : toolNodeId,
          rootNodeId: command === undefined ? nodeId : toolNodeId,
          kind: "approval_request",
          runtimeRequestId: requestId,
        },
      },
      ...(withCard ? [approvalCard(name, prompt, kind, now)] : []),
      {
        id: EventId.make(`request:${name}`),
        type: "runtime-request.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: requestId,
          nodeId,
          providerTurnId: null,
          nativeRequestRef: null,
          kind,
          status: "pending",
          responseCapability: { type: "live", providerSessionId: sessionId },
          createdAt: now,
          resolvedAt: null,
        },
      },
    ],
  });
  return requestId;
});

/** Commits a later state of a request, as a turn end, stop, or lost session does. */
const updateRequest = Effect.fn("updateRequest")(function* (
  requestId: RuntimeRequestId,
  change: Partial<Pick<OrchestrationV2RuntimeRequest, "status" | "responseCapability">>,
) {
  const sink = yield* EventSink.EventSinkV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const current = yield* projections.getRuntimeRequest(threadId, requestId);
  const now = yield* DateTime.now;
  yield* sink.write({
    events: [
      {
        id: EventId.make(`update:${requestId}:${change.status ?? "capability"}`),
        type: "runtime-request.updated",
        threadId,
        occurredAt: now,
        payload: { ...current!, ...change },
      },
    ],
  });
});

const userAnswers = (requestId: RuntimeRequestId, decision: "accept" | "decline") =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.dispatch({
      type: "runtime-request.respond",
      commandId: CommandId.make(`user:${requestId}`),
      threadId,
      requestId,
      decision,
    }),
  );

const outcome = (requestId: RuntimeRequestId) =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const { request, item } = yield* projections.getRuntimeResponseContext(threadId, requestId);
    return {
      status: request?.status,
      decision: request?.decision,
      item: item?.status,
      resolvedBy: item?.type === "approval_request" ? item.resolvedBy : undefined,
    };
  });

const DIGEST = `sha256:${"0".repeat(64)}`;
const decodeInstallation = Schema.decodeUnknownSync(PluginInstallation);

interface StubPlugin {
  readonly id: string;
  readonly kinds?: ReadonlyArray<string>;
  readonly timeoutSeconds?: number;
  readonly decide: (input: Schema.Json, timeout: Duration.Input | undefined) => InvokeResult;
}

/** An in-memory catalogue of enabled plugins that declare approvals and answer through `decide`. */
const stubCatalog = (plugins: ReadonlyArray<StubPlugin>) => {
  const rows = plugins.map((plugin) =>
    decodeInstallation({
      installationId: plugin.id,
      generation: 1,
      directory: `/plugins/${plugin.id}`,
      manifest: {
        id: plugin.id,
        name: `Plugin ${plugin.id}`,
        version: "1.0.0",
        capabilities: ["approvals"],
        proposedApi: true,
        approvals: {
          kinds: plugin.kinds ?? ["command"],
          ...(plugin.timeoutSeconds === undefined ? {} : { timeoutSeconds: plugin.timeoutSeconds }),
        },
      },
      source: { digest: DIGEST, files: 1, bytes: 1 },
      problem: null,
      inspectedAt: "2026-01-01T00:00:00.000Z",
      consent: {
        digest: DIGEST,
        capabilities: ["approvals"],
        grantedAt: "2026-01-01T00:00:00.000Z",
      },
      enabled: true,
      hostState: { _tag: "idle" },
      addedAt: "2026-01-01T00:00:00.000Z",
    }),
  );
  const unused = () => Effect.die("not used by PluginApprovals");
  return PluginCatalog.PluginCatalog.of({
    list: Effect.sync(() => ({ installations: rows })),
    revision: Effect.succeed(0),
    subscribe: Stream.empty,
    add: unused,
    refresh: unused,
    consent: unused,
    enable: unused,
    disable: unused,
    remove: unused,
    resume: unused,
    replace: unused,
    settleReplace: unused,
    changeFiles: unused,
    invoke: (installationId, handler, input, options) => {
      expect(handler).toBe("t3.approval.decide");
      const plugin = plugins.find((candidate) => candidate.id === installationId);
      return plugin === undefined
        ? Effect.die(`unknown plugin ${installationId}`)
        : plugin.decide(input, options?.timeout);
    },
  });
};

/** Starts the participant in the test's scope and follows its receipts. */
const startApprovals = Effect.fn("startApprovals")(function* (
  catalog: PluginCatalog.PluginCatalog["Service"],
  options?: PluginApprovals.PluginApprovalsOptions,
) {
  const approvals = yield* PluginApprovals.make(options).pipe(
    Effect.provideService(PluginCatalog.PluginCatalog, catalog),
    Effect.provideService(
      ServerEnvironment,
      ServerEnvironment.of({
        getEnvironmentId: Effect.succeed(environmentId),
        getDescriptor: Effect.die("unused"),
      }),
    ),
  );
  const subscription = yield* approvals.subscribe;
  const seen: Array<Receipt> = [];
  /** Takes receipts in order until one matches. */
  const until = (predicate: (receipt: Receipt) => boolean) =>
    Effect.gen(function* () {
      while (true) {
        const receipt = yield* PubSub.take(subscription);
        seen.push(receipt);
        if (predicate(receipt)) return receipt;
      }
    });
  return { seen, until };
});

const is =
  <Tag extends Exclude<Receipt["_tag"], "Skipped">>(tag: Tag, installationId: string) =>
  (receipt: Receipt): receipt is Extract<Receipt, { _tag: Tag }> =>
    receipt._tag === tag && receipt.installationId === installationId;

const skipped = (requestId: RuntimeRequestId) => (receipt: Receipt) =>
  receipt._tag === "Skipped" && receipt.requestId === requestId;

/** The first receipt that ends a request's offer for a plugin, or skips the request. */
const settled = (requestId: RuntimeRequestId) => (receipt: Receipt) =>
  receipt.requestId === requestId && receipt._tag !== "Asked";

const answer = (value: Schema.Json): InvokeResult => Effect.succeed(value);

/** A call that answers `value` once `release` completes and can be cancelled before. */
const heldAnswer = (release: Deferred.Deferred<Schema.Json>): InvokeResult =>
  Deferred.await(release);

/** An answer already on its way when the call is cancelled: it still arrives. */
const answerInFlight = (release: Deferred.Deferred<Schema.Json>): InvokeResult =>
  Effect.uninterruptible(Deferred.await(release));

const withOrchestration = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(orchestration));

it.layer(NodeServices.layer)("PluginApprovals", (it) => {
  describe("answers", () => {
    it.effect("records an approve or deny once, attributed to the plugin, before the user", () =>
      withOrchestration(
        Effect.gen(function* () {
          yield* createThread;
          const inputs: Array<Schema.Json> = [];
          const { until } = yield* startApprovals(
            stubCatalog([
              {
                id: "test.policy",
                decide: (input) => {
                  inputs.push(input);
                  const prompt = (input as { prompt: string }).prompt;
                  return answer(
                    prompt === "git status"
                      ? { decision: "approve", reason: "Read-only." }
                      : { decision: "deny" },
                  );
                },
              },
            ]),
          );

          const approved = yield* raise("approved", "git status", "command", "git status --short");
          expect(yield* until(is("Recorded", "test.policy"))).toMatchObject({
            requestId: approved,
            decision: "accept",
          });
          expect(yield* outcome(approved)).toEqual({
            status: "resolved",
            decision: "accept",
            item: "completed",
            resolvedBy: {
              _tag: "plugin",
              pluginId: "test.policy",
              pluginName: "Plugin test.policy",
              decision: "accept",
              reason: "Read-only.",
            },
          });
          // Exactly the bounded summary, with the context from the server.
          expect(inputs[0]).toEqual({
            requestId: approved,
            kind: "command",
            prompt: "git status",
            subject: "git status --short",
            context: { environmentId, projectId, threadId, runId: null, provider: "codex" },
          });
          // The user's late answer is refused and changes nothing.
          const late = yield* Effect.flip(userAnswers(approved, "decline"));
          expect(userFacingDispatchErrorMessage(late)).toContain("is resolved");
          expect((yield* outcome(approved)).decision).toBe("accept");

          const denied = yield* raise("denied", "rm -rf build");
          expect(yield* until(is("Recorded", "test.policy"))).toMatchObject({
            requestId: denied,
            decision: "decline",
          });
          expect(yield* outcome(denied)).toEqual({
            status: "resolved",
            decision: "decline",
            item: "cancelled",
            resolvedBy: {
              _tag: "plugin",
              pluginId: "test.policy",
              pluginName: "Plugin test.policy",
              decision: "decline",
            },
          });
        }),
      ),
    );

    it.effect(
      "leaves the request to the user on abstain, bad answers, failures and the deadline",
      () =>
        withOrchestration(
          Effect.gen(function* () {
            yield* createThread;
            const timeouts: Array<Duration.Input | undefined> = [];
            const failing = (error: PluginCatalogError | PluginSupervisor.PluginInvokeError) =>
              Effect.fail(error);
            const { seen, until } = yield* startApprovals(
              stubCatalog([
                {
                  id: "test.abstain",
                  decide: () => answer({ decision: "abstain", reason: "n/a" }),
                },
                { id: "test.null", decide: () => answer(null) },
                { id: "test.invalid", decide: () => answer({ decision: "maybe" }) },
                {
                  id: "test.long-reason",
                  decide: () => answer({ decision: "approve", reason: "x".repeat(501) }),
                },
                {
                  id: "test.throws",
                  decide: () =>
                    failing(
                      new PluginSupervisor.PluginCallFailedError({
                        pluginId: "test.throws",
                        handler: "t3.approval.decide",
                        reason: "boom",
                      }),
                    ),
                },
                {
                  id: "test.slow",
                  timeoutSeconds: 7,
                  decide: (_input, timeout) => {
                    timeouts.push(timeout);
                    return failing(
                      new PluginSupervisor.PluginTimeoutError({
                        pluginId: "test.slow",
                        handler: "t3.approval.decide",
                        timeoutMs: 7000,
                      }),
                    );
                  },
                },
                {
                  id: "test.default-deadline",
                  decide: (_input, timeout) => {
                    timeouts.push(timeout);
                    return answer(null);
                  },
                },
                {
                  id: "test.disabled",
                  decide: () =>
                    failing(new PluginSupervisor.PluginStoppedError({ pluginId: "test.disabled" })),
                },
                {
                  id: "test.files-only",
                  kinds: ["file-change"],
                  decide: () => Effect.die("never asked about commands"),
                },
              ]),
            );

            const requestId = yield* raise("abstained", "npm test");
            const causes = new Map<string, string>();
            while (causes.size < 8) {
              const receipt = yield* until((candidate) => candidate._tag === "Abstained");
              if (receipt._tag === "Abstained") causes.set(receipt.installationId, receipt.cause);
            }
            expect(Object.fromEntries(causes)).toEqual({
              "test.abstain": "abstained",
              "test.null": "abstained",
              "test.invalid": "invalid",
              "test.long-reason": "invalid",
              "test.throws": "failed",
              "test.slow": "deadline",
              "test.default-deadline": "abstained",
              "test.disabled": "unavailable",
            });
            expect(timeouts.toSorted()).toEqual(["15 seconds", "7 seconds"]);
            expect(
              seen.some(
                (receipt) =>
                  receipt._tag !== "Skipped" && receipt.installationId === "test.files-only",
              ),
            ).toBe(false);
            expect(yield* outcome(requestId)).toMatchObject({ status: "pending", item: "waiting" });

            // The user still decides, and the record shows no plugin.
            yield* userAnswers(requestId, "accept");
            expect(yield* outcome(requestId)).toEqual({
              status: "resolved",
              decision: "accept",
              item: "completed",
              resolvedBy: undefined,
            });
          }),
        ),
    );
  });

  describe("races", () => {
    it.effect("lets the first plugin answer win and refuses or withdraws the others", () =>
      withOrchestration(
        Effect.gen(function* () {
          yield* createThread;
          const first = yield* Deferred.make<Schema.Json>();
          const crossing = yield* Deferred.make<Schema.Json>();
          const thinking = yield* Deferred.make<Schema.Json>();
          const { until } = yield* startApprovals(
            stubCatalog([
              { id: "test.first", decide: () => heldAnswer(first) },
              { id: "test.crossing", decide: () => answerInFlight(crossing) },
              { id: "test.thinking", decide: () => heldAnswer(thinking) },
            ]),
          );
          const requestId = yield* raise("plugins", "git push");
          for (const id of ["test.first", "test.crossing", "test.thinking"])
            yield* until(is("Asked", id));

          yield* Deferred.succeed(first, { decision: "approve" });
          yield* until(is("Recorded", "test.first"));
          // An answer that crossed the cancellation is refused by the orchestrator.
          yield* Deferred.succeed(crossing, { decision: "deny" });
          const refused = yield* until(is("Refused", "test.crossing"));
          expect(refused).toMatchObject({ decision: "decline" });
          expect(refused._tag === "Refused" && refused.message).toContain("is resolved");
          // The recorded answer withdraws the call still deciding.
          expect(yield* until(is("Abstained", "test.thinking"))).toMatchObject({
            cause: "withdrawn",
          });
          expect(yield* outcome(requestId)).toMatchObject({
            status: "resolved",
            decision: "accept",
            resolvedBy: { pluginId: "test.first", decision: "accept" },
          });
        }),
      ),
    );

    it.effect("withdraws plugin calls when the user answers first", () =>
      withOrchestration(
        Effect.gen(function* () {
          yield* createThread;
          const held = yield* Deferred.make<Schema.Json>();
          const crossing = yield* Deferred.make<Schema.Json>();
          const { until } = yield* startApprovals(
            stubCatalog([
              { id: "test.held", decide: () => heldAnswer(held) },
              { id: "test.crossing", decide: () => answerInFlight(crossing) },
            ]),
          );
          const requestId = yield* raise("user-first", "git push");
          yield* until(is("Asked", "test.held"));
          yield* until(is("Asked", "test.crossing"));

          yield* userAnswers(requestId, "decline");
          expect(yield* until(is("Abstained", "test.held"))).toMatchObject({
            cause: "withdrawn",
          });
          yield* Deferred.succeed(crossing, { decision: "approve" });
          expect(yield* until(is("Refused", "test.crossing"))).toMatchObject({
            decision: "accept",
          });
          expect(yield* outcome(requestId)).toEqual({
            status: "resolved",
            decision: "decline",
            item: "cancelled",
            resolvedBy: undefined,
          });
        }),
      ),
    );

    it.effect(
      "withdraws calls when the turn ends or the session is lost, and refuses late answers",
      () =>
        withOrchestration(
          Effect.gen(function* () {
            yield* createThread;
            const ended = yield* Deferred.make<Schema.Json>();
            const lost = yield* Deferred.make<Schema.Json>();
            const { until } = yield* startApprovals(
              stubCatalog([
                {
                  id: "test.late",
                  decide: (input) =>
                    answerInFlight((input as { prompt: string }).prompt === "ended" ? ended : lost),
                },
              ]),
            );

            const endedRequest = yield* raise("ended", "ended");
            yield* until(is("Asked", "test.late"));
            yield* updateRequest(endedRequest, { status: "cancelled" });
            yield* Deferred.succeed(ended, { decision: "approve" });
            const refusedEnded = yield* until(is("Refused", "test.late"));
            expect(refusedEnded._tag === "Refused" && refusedEnded.message).toContain(
              "is cancelled",
            );
            expect(yield* outcome(endedRequest)).toMatchObject({
              status: "cancelled",
              resolvedBy: undefined,
            });

            const lostRequest = yield* raise("lost", "lost");
            yield* until(is("Asked", "test.late"));
            yield* updateRequest(lostRequest, {
              responseCapability: { type: "not_resumable", reason: "The session ended." },
            });
            yield* Deferred.succeed(lost, { decision: "deny" });
            const refusedLost = yield* until(is("Refused", "test.late"));
            expect(refusedLost._tag === "Refused" && refusedLost.message).toContain(
              "The session ended.",
            );
            expect(yield* outcome(lostRequest)).toMatchObject({ status: "pending" });
          }),
        ),
    );

    it.effect("offers only requests raised after it starts, as after a restart", () =>
      withOrchestration(
        Effect.gen(function* () {
          yield* createThread;
          const before = yield* raise("before-start", "git status");
          const { seen, until } = yield* startApprovals(
            stubCatalog([{ id: "test.policy", decide: () => answer({ decision: "approve" }) }]),
          );
          const after = yield* raise("after-start", "git status");
          yield* until(is("Recorded", "test.policy"));
          expect(seen.map((receipt) => receipt.requestId)).toEqual([after, after]);
          expect(yield* outcome(before)).toMatchObject({ status: "pending" });
        }),
      ),
    );
  });

  describe("card order", () => {
    // Each marker request is offered only after the requests committed before it were seen.
    const policy = (inputs: Array<Schema.Json>) =>
      stubCatalog([
        {
          id: "test.policy",
          decide: (input) => {
            inputs.push(input);
            return answer({ decision: "approve" });
          },
        },
      ]);

    it.effect("asks plugins once the card lands after the request, with its prompt", () =>
      withOrchestration(
        Effect.gen(function* () {
          yield* createThread;
          const inputs: Array<Schema.Json> = [];
          const { seen, until } = yield* startApprovals(policy(inputs));
          const late = yield* raise("card-late", "", "command", "git status", false);
          const marker = yield* raise("card-late-marker", "marker");
          expect(yield* until(is("Recorded", "test.policy"))).toMatchObject({ requestId: marker });
          expect(seen.filter((receipt) => receipt.requestId === late)).toEqual([]);

          yield* commitCard("card-late", "Check the repository status");
          expect(yield* until(is("Recorded", "test.policy"))).toMatchObject({ requestId: late });
          expect(inputs[1]).toMatchObject({
            requestId: late,
            prompt: "Check the repository status",
            subject: "git status",
          });
          expect(yield* outcome(late)).toMatchObject({
            status: "resolved",
            decision: "accept",
            resolvedBy: { pluginId: "test.policy" },
          });
        }),
      ),
    );

    it.effect("asks no plugin when the card that lands after the request is too long", () =>
      withOrchestration(
        Effect.gen(function* () {
          yield* createThread;
          const inputs: Array<Schema.Json> = [];
          const { seen, until } = yield* startApprovals(policy(inputs));
          const late = yield* raise("card-long", "", "command", "git status", false);
          const marker = yield* raise("card-long-marker", "marker");
          expect(yield* until(is("Recorded", "test.policy"))).toMatchObject({ requestId: marker });

          yield* commitCard("card-long", "x".repeat(PLUGIN_APPROVAL_LIMITS.maxPromptLength + 1));
          expect(yield* until(settled(late))).toMatchObject({
            _tag: "Skipped",
            cause: "incomplete",
          });
          expect(seen.filter((receipt) => receipt.requestId === late)).toHaveLength(1);
          expect(inputs).toHaveLength(1);
          expect(yield* outcome(late)).toMatchObject({ status: "pending", item: "waiting" });
        }),
      ),
    );

    it.effect("leaves a request whose card never arrives, or has no prompt, to the user", () =>
      withOrchestration(
        Effect.gen(function* () {
          yield* createThread;
          const inputs: Array<Schema.Json> = [];
          const { seen, until } = yield* startApprovals(policy(inputs));
          const cardless = yield* raise("cardless", "", "command", "git status", false);
          const promptless = yield* raise("promptless", "", "command", "git status", false);
          yield* commitCard("promptless", undefined);
          const marker = yield* raise("cardless-marker", "marker");
          expect(yield* until(is("Recorded", "test.policy"))).toMatchObject({ requestId: marker });

          yield* userAnswers(cardless, "decline");
          yield* userAnswers(promptless, "accept");
          const after = yield* raise("cardless-after", "after");
          expect(yield* until(is("Recorded", "test.policy"))).toMatchObject({ requestId: after });
          expect(seen.map((receipt) => receipt.requestId)).toEqual([marker, marker, after, after]);
          expect(yield* outcome(cardless)).toMatchObject({
            status: "resolved",
            decision: "decline",
            resolvedBy: undefined,
          });
          expect(yield* outcome(promptless)).toMatchObject({
            status: "resolved",
            decision: "accept",
            resolvedBy: undefined,
          });
        }),
      ),
    );
  });

  describe("limits", () => {
    it.effect("asks no plugin about a request longer than a plugin may receive", () =>
      withOrchestration(
        Effect.gen(function* () {
          yield* createThread;
          const allowed = `echo ${"a".repeat(PLUGIN_APPROVAL_LIMITS.maxPromptLength - 5)}`;
          const subjects: Array<string | undefined> = [];
          const { seen, until } = yield* startApprovals(
            stubCatalog([
              {
                id: "test.exact",
                decide: (input) => {
                  const { subject } = input as { subject?: string };
                  subjects.push(subject);
                  return answer(subject === allowed ? { decision: "approve" } : null);
                },
              },
            ]),
          );

          // The allowed command plus an operation past the limit: never cut down to the allowed one.
          const suffixed = yield* raise(
            "suffixed",
            "Run a command",
            "command",
            `${allowed}; touch forbidden-proof-file`,
          );
          expect(yield* until(settled(suffixed))).toMatchObject({
            _tag: "Skipped",
            cause: "incomplete",
          });
          const longPrompt = yield* raise(
            "long-prompt",
            "x".repeat(PLUGIN_APPROVAL_LIMITS.maxPromptLength + 1),
          );
          expect(yield* until(settled(longPrompt))).toMatchObject({
            _tag: "Skipped",
            cause: "incomplete",
          });

          // Exactly at the limit it is whole, so the plugin decides.
          const whole = yield* raise("whole", "Run a command", "command", allowed);
          expect(yield* until(is("Recorded", "test.exact"))).toMatchObject({ requestId: whole });
          expect(subjects).toEqual([allowed]);
          expect(seen.filter((receipt) => receipt.requestId !== whole)).toHaveLength(2);
          expect(yield* outcome(suffixed)).toMatchObject({ status: "pending", item: "waiting" });
          expect(yield* outcome(longPrompt)).toMatchObject({ status: "pending", item: "waiting" });
        }),
      ),
    );

    it.effect("skips requests past the active offer limit and never re-offers them", () =>
      withOrchestration(
        Effect.gen(function* () {
          yield* createThread;
          const held = yield* Deferred.make<Schema.Json>();
          const asked: Array<string> = [];
          const { seen, until } = yield* startApprovals(
            stubCatalog([
              {
                id: "test.policy",
                decide: (input) => {
                  const { prompt } = input as { prompt: string };
                  asked.push(prompt);
                  return prompt === "first" ? heldAnswer(held) : answer({ decision: "approve" });
                },
              },
            ]),
            { maxActiveOffers: 1 },
          );
          const first = yield* raise("limit-first", "first");
          yield* until(is("Asked", "test.policy"));

          const second = yield* raise("limit-second", "second");
          expect(yield* until(skipped(second))).toMatchObject({ cause: "overloaded" });
          // Repeated pending updates neither re-offer the live request nor the skipped one:
          // either would be skipped as overloaded before the marker below.
          yield* updateRequest(first, { status: "pending" });
          yield* updateRequest(second, { status: "pending" });
          const marker = yield* raise("limit-marker", "marker");
          yield* until(skipped(marker));
          expect(
            seen
              .filter((receipt) => receipt._tag === "Skipped")
              .map((receipt) => receipt.requestId),
          ).toEqual([second, marker]);

          // The live offer still owns its call: answering withdraws it and frees the slot.
          yield* userAnswers(first, "decline");
          expect(yield* until(is("Abstained", "test.policy"))).toMatchObject({
            requestId: first,
            cause: "withdrawn",
          });
          const third = yield* raise("limit-third", "third");
          expect(yield* until(is("Recorded", "test.policy"))).toMatchObject({ requestId: third });
          expect(asked).toEqual(["first", "third"]);
          expect(yield* outcome(second)).toMatchObject({ status: "pending", item: "waiting" });
        }),
      ),
    );

    it.effect("abstains at once when the plugin call limit is reached", () =>
      withOrchestration(
        Effect.gen(function* () {
          yield* createThread;
          const held = yield* Deferred.make<Schema.Json>();
          const { until } = yield* startApprovals(
            stubCatalog([
              {
                id: "test.policy",
                // A call still being prepared (the catalogue inspects the plugin inside
                // `invoke`, before the supervisor admits it) holds its place.
                decide: (input) =>
                  (input as { prompt: string }).prompt === "preparing"
                    ? heldAnswer(held)
                    : answer({ decision: "approve" }),
              },
            ]),
            { maxActiveCalls: 1 },
          );
          const preparing = yield* raise("calls-preparing", "preparing");
          yield* until(is("Asked", "test.policy"));
          const next = yield* raise("calls-next", "next");
          expect(yield* until(is("Abstained", "test.policy"))).toMatchObject({
            requestId: next,
            cause: "overloaded",
          });
          expect(yield* outcome(next)).toMatchObject({ status: "pending", item: "waiting" });

          yield* Deferred.succeed(held, { decision: "approve" });
          expect(yield* until(is("Recorded", "test.policy"))).toMatchObject({
            requestId: preparing,
          });
          const after = yield* raise("calls-after", "after");
          expect(yield* until(is("Recorded", "test.policy"))).toMatchObject({ requestId: after });
        }),
      ),
    );
  });

  it.effect("refuses plugin answers to requests plugins may not answer", () =>
    withOrchestration(
      Effect.gen(function* () {
        yield* createThread;
        const { seen, until } = yield* startApprovals(
          stubCatalog([
            {
              id: "test.everything",
              kinds: ["command", "file-read", "file-change", "permission"],
              decide: () => answer({ decision: "approve" }),
            },
          ]),
        );
        const elicitation = yield* raise("elicitation", "Allow the app?", "mcp-elicitation");
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const refused = yield* Effect.flip(
          orchestrator.dispatch({
            type: "runtime-request.plugin-respond",
            commandId: CommandId.make("plugin:elicitation"),
            threadId,
            requestId: elicitation,
            resolvedBy: {
              _tag: "plugin",
              pluginId: "test.everything",
              pluginName: "Everything",
              decision: "accept",
            },
          }),
        );
        expect(userFacingDispatchErrorMessage(refused)).toBe(
          "Plugins cannot answer mcp-elicitation requests.",
        );
        // A later command request is offered, and the elicitation never was.
        const command = yield* raise("command", "ls");
        yield* until(is("Recorded", "test.everything"));
        expect(seen.every((receipt) => receipt.requestId === command)).toBe(true);
        expect(yield* outcome(elicitation)).toMatchObject({ status: "pending" });
      }),
    ),
  );

  it.effect("loads approvals only with the capability, the declaration and the proposed API", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-plugin-approvals-" });
      const load = Effect.fn("load")(function* (name: string, manifest: Record<string, unknown>) {
        const directory = path.join(root, name);
        yield* fs.makeDirectory(directory);
        yield* fs.writeFileString(
          path.join(directory, "main.mjs"),
          "export function activate() {}\n",
        );
        yield* fs.writeFileString(
          path.join(directory, "t3-plugin.json"),
          toJson({
            id: `test.${name}`,
            name,
            version: "1.0.0",
            apiVersion: 1,
            entry: "main.mjs",
            proposedApi: true,
            ...manifest,
          }),
        );
        return yield* loadPluginDirectory(directory).pipe(
          Effect.map(() => "loaded"),
          Effect.catch((error) => Effect.succeed(error.reason)),
        );
      });
      const approvals = { kinds: ["command"] };
      expect(yield* load("valid", { capabilities: ["approvals"], approvals })).toBe("loaded");
      expect(yield* load("undeclared", { capabilities: ["approvals"] })).toBe(
        "it declares the approvals capability without an approvals object.",
      );
      expect(yield* load("uncapable", { capabilities: [], approvals })).toBe(
        "it declares approvals without the approvals capability.",
      );
      expect(
        yield* load("unproposed", { capabilities: ["approvals"], approvals, proposedApi: false }),
      ).toBe("it declares approvals, which need proposedApi: true.");
    }),
  );

  it.effect("answers through a real plugin process and abstains at once when it is disabled", () =>
    withOrchestration(
      Effect.gen(function* () {
        yield* createThread;
        const scope = yield* Scope.Scope;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = path.join(
          yield* fs.makeTempDirectoryScoped({ prefix: "t3-plugin-approvals-" }),
          "plugin",
        );
        yield* fs.copy(FIXTURE, directory);
        const supervisor = yield* PluginSupervisor.make({
          heapLimitMb: 64,
          activationTimeout: "10 seconds",
          stopGrace: "1 second",
        }).pipe(
          Effect.provideService(HostProcess.Arguments, [process.execPath, BIN_PATH]),
          Effect.provideService(Scope.Scope, scope),
        );
        const catalog = yield* PluginCatalog.make().pipe(
          Effect.provideService(PluginSupervisor.PluginSupervisor, supervisor),
          Effect.provideService(Scope.Scope, scope),
        );
        const { installation } = yield* catalog.add({ directory });
        const installationId = installation.installationId;
        expect(installation.manifest?.approvals).toEqual({
          kinds: ["command"],
          timeoutSeconds: 30,
        });
        yield* catalog.consent({ installationId, digest: installation.source!.digest });
        yield* catalog.enable({ installationId });
        const { until } = yield* startApprovals(catalog);

        // A command that only starts with an allowed one is not that command.
        const compound = yield* raise("real-compound", "git status && touch changed-file");
        expect(yield* until(is("Abstained", installationId))).toMatchObject({
          requestId: compound,
          cause: "abstained",
        });
        expect(yield* outcome(compound)).toMatchObject({ status: "pending", item: "waiting" });

        const approved = yield* raise("real-approve", "git status");
        yield* until(is("Recorded", installationId));
        expect(yield* outcome(approved)).toMatchObject({
          status: "resolved",
          resolvedBy: {
            pluginId: "test.approvals",
            pluginName: "Approvals fixture",
            decision: "accept",
            reason: "Read-only git command.",
          },
        });

        const held = yield* raise("real-hold", "hold");
        yield* until(is("Asked", installationId));
        yield* catalog.disable({ installationId });
        expect(yield* until(is("Abstained", installationId))).toMatchObject({
          requestId: held,
          cause: "unavailable",
        });
        expect(yield* outcome(held)).toMatchObject({ status: "pending", item: "waiting" });
      }),
    ),
  );
});
