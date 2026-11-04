import { describe, expect, it, vi } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  OrchestrationV2ProviderThread,
  RuntimeRequestId,
  NodeId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as Adapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Adapters from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as Runner from "./CommitWorkflowRunner.ts";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("source-control-writer");
const now = DateTime.makeUnsafe("2026-11-03T12:00:00Z");
const providerThread = Schema.decodeSync(OrchestrationV2ProviderThread)({
  id: ProviderThreadId.make("native-thread"),
  driver,
  providerInstanceId: instanceId,
  providerSessionId: null,
  appThreadId: null,
  ownerNodeId: null,
  nativeThreadRef: null,
  nativeConversationHeadRef: null,
  status: "idle",
  firstRunOrdinal: null,
  lastRunOrdinal: null,
  handoffIds: [],
  forkedFrom: null,
  createdAt: now,
  updatedAt: now,
});
const input: Runner.CommitWorkflowRunInput = {
  request: {
    commandId: CommandId.make("action"),
    threadId: ThreadId.make("source-thread"),
    cwd: "/repo",
    expectedBranch: "feature",
    scope: { type: "working_tree" },
  },
  projectId: ProjectId.make("project"),
  modelSelection: {
    instanceId,
    model: "configured-model",
    options: [{ id: "reasoningEffort", value: "high" }],
  },
  style: {
    mode: "custom",
    customInstructions: "Write German subjects.",
    followChangeRequestTemplates: true,
  },
};
const terminal = (
  status: "completed" | "interrupted" = "completed",
): Adapter.ProviderAdapterV2Event => ({
  type: "turn.terminal",
  driver,
  providerThreadId: providerThread.id,
  providerTurnId: ProviderTurnId.make("turn"),
  runOrdinal: 1,
  status,
  failure: null,
  threadDisposition: "reusable",
});

const harness = Effect.fn("TestCommitRunner.harness")(function* (
  options: {
    outcome?: "completed" | "failed" | "request" | "wait" | "stream_end";
    directStream?: boolean;
  } = {},
) {
  const events = yield* Queue.unbounded<Adapter.ProviderAdapterV2Event, Cause.Done>();
  const started = yield* Deferred.make<void>();
  const closed = vi.fn();
  const subscriptionClosed = vi.fn();
  const startTurn = vi.fn((turn: Adapter.ProviderAdapterV2TurnInput) =>
    Effect.gen(function* () {
      yield* Deferred.succeed(started, undefined);
      if (options.outcome === "wait") return;
      if (options.outcome === "stream_end") {
        yield* Queue.end(events);
        return;
      }
      if (options.outcome === "request") {
        yield* Queue.offer(events, {
          type: "runtime_request.updated",
          driver,
          runtimeRequest: {
            id: RuntimeRequestId.make("request"),
            nodeId: NodeId.make("node"),
            providerTurnId: null,
            nativeRequestRef: null,
            kind: "user_input",
            status: "pending",
            responseCapability: { type: "not_resumable", reason: "test" },
            createdAt: now,
            resolvedAt: null,
          },
        });
        return;
      }
      if (options.outcome === "failed") {
        yield* Queue.offer(events, {
          type: "turn.terminal",
          driver,
          providerThreadId: providerThread.id,
          providerTurnId: ProviderTurnId.make("turn"),
          runOrdinal: 1,
          failureItemOrdinal: 1,
          status: "failed",
          threadDisposition: "broken",
          failure: {
            class: "provider_error",
            message: "Provider unavailable",
            code: null,
            retryable: false,
          },
        });
        return;
      }
      yield* Queue.offer(events, {
        type: "message.updated",
        driver,
        message: {
          id: MessageId.make("answer"),
          threadId: turn.threadId,
          runId: turn.runId,
          nodeId: null,
          role: "assistant",
          text: "Created 33 commits. Backup: refs/backup/original",
          attachments: [],
          streaming: false,
          createdAt: now,
          updatedAt: now,
          createdBy: "agent",
          creationSource: "provider",
        },
      });
      yield* Queue.offer(events, terminal());
    }),
  );
  const runtime = {
    ensureThread: () => Effect.succeed(providerThread),
    events: Stream.fromQueue(events),
    startTurn,
    ...(options.directStream
      ? {}
      : {
          subscribeEvents: Effect.succeed({
            events: Stream.fromQueue(events),
            close: Effect.sync(() => {
              subscriptionClosed();
            }),
          }),
        }),
  } as unknown as Adapter.ProviderAdapterV2SessionRuntime;
  const openSession = vi.fn((_request: Adapter.ProviderAdapterV2OpenSessionInput) =>
    Effect.acquireRelease(Effect.succeed(runtime), () =>
      Effect.sync(() => {
        closed();
      }),
    ),
  );
  const adapter = {
    instanceId,
    driver,
    openSession,
  } as unknown as Adapter.ProviderAdapterV2["Service"];
  const layer = Runner.layer.pipe(
    Layer.provide(
      Layer.mock(Adapters.ProviderAdapterRegistryV2)({ get: () => Effect.succeed(adapter) }),
    ),
  );
  return { layer, openSession, startTurn, closed, subscriptionClosed, started };
});

describe("commit quick-action provider session", () => {
  it.effect.each([false, true])(
    "uses a fresh scoped session without creating or resuming an app conversation (direct events: %s)",
    (directStream) =>
      Effect.gen(function* () {
        const h = yield* harness({ directStream });
        const result = yield* Effect.gen(function* () {
          const runner = yield* Runner.CommitWorkflowRunner;
          return yield* runner.run(input);
        }).pipe(Effect.provide(h.layer));
        expect(result.summary).toContain("33 commits");
        expect(h.openSession.mock.calls[0]![0].modelSelection).toEqual(input.modelSelection);
        expect(h.openSession.mock.calls[0]![0]).not.toHaveProperty("resumeFromSession");
        const turn = h.startTurn.mock.calls[0]![0];
        expect(turn.threadId).not.toBe(input.request.threadId);
        expect(turn.nativeThreadHasTurns).toBe(false);
        expect(turn.appThread.lineage.parentThreadId).toBeNull();
        expect(turn.appThread.historyOrigin).toBeUndefined();
        expect(turn).not.toHaveProperty("appContext");
        expect(turn.message.text).toContain("Write German subjects.");
        expect(turn.message.text).toContain(".t3code/commit-message.md");
        expect(h.closed).toHaveBeenCalledTimes(1);
        if (!directStream) expect(h.subscriptionClosed).toHaveBeenCalledTimes(1);
      }),
  );

  it.effect.each([false, true])(
    "keeps validation opt-in while preserving Git safety checks (requested: %s)",
    (requested) =>
      Effect.gen(function* () {
        const h = yield* harness();
        const instructions = "Run the focused PHPUnit tests at dependency boundaries.";
        yield* Effect.gen(function* () {
          const runner = yield* Runner.CommitWorkflowRunner;
          yield* runner.run({
            ...input,
            request: {
              ...input.request,
              ...(requested ? { instructions } : {}),
            },
          });
        }).pipe(Effect.provide(h.layer));
        const prompt = h.startTurn.mock.calls[0]![0].message.text;
        expect(prompt).toContain(
          "Run builds, typechecks, linters, tests, or IDE diagnostics only when explicitly requested in Additional requirements",
        );
        expect(prompt).toContain("skip these checks and dependency/runtime setup");
        expect(prompt).toContain(
          "even if general repository instructions normally require validation",
        );
        expect(prompt).not.toContain("Use the project's setup procedure");
        expect(prompt).toContain("Inspect intermediate commits for dependency ordering");
        expect(prompt).toContain("compare the candidate Git tree object");
        expect(prompt).toContain("have not changed since the snapshot");
        expect(prompt.includes(`Additional requirements:\n\n${instructions}`)).toBe(requested);
      }),
  );

  it.effect.each(["failed", "request", "stream_end"] as const)(
    "reports %s and releases the provider session",
    (outcome) =>
      Effect.gen(function* () {
        const h = yield* harness({ outcome });
        const error = yield* Effect.gen(function* () {
          const runner = yield* Runner.CommitWorkflowRunner;
          return yield* runner.run(input).pipe(Effect.flip);
        }).pipe(Effect.provide(h.layer));
        expect(error._tag).toBe("GitManagerError");
        expect(h.closed).toHaveBeenCalledTimes(1);
      }),
  );

  it.effect("closes the provider session when the action is cancelled", () =>
    Effect.gen(function* () {
      const h = yield* harness({ outcome: "wait" });
      yield* Effect.gen(function* () {
        const runner = yield* Runner.CommitWorkflowRunner;
        const action = yield* runner.run(input).pipe(Effect.forkChild);
        yield* Deferred.await(h.started);
        yield* Fiber.interrupt(action);
        expect(h.closed).toHaveBeenCalledTimes(1);
      }).pipe(Effect.provide(h.layer));
    }),
  );
});
