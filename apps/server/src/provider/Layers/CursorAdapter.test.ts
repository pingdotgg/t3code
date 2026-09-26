import type { InteractionUpdate, RunResult } from "@cursor/sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import type {
  CursorAgentSdkOpenInput,
  CursorAgentSdkRunnerShape,
  CursorAgentSdkSession,
} from "../CursorAgentSdk.ts";
import { makeCursorAdapter } from "./CursorAdapter.ts";

const instanceId = ProviderInstanceId.make("cursor");
const provider = ProviderDriverKind.make("cursor");

const testLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-cursor-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

interface FakeRunScript {
  readonly updates: ReadonlyArray<InteractionUpdate>;
  /** Resolves the run. Defaults to a finished run. */
  readonly wait?: Effect.Effect<RunResult>;
  readonly onCancel?: Effect.Effect<void>;
}

/** Stands in for the SDK. Each `send` replays the next script through `onDelta`. */
const makeFakeRunner = (scripts: Array<FakeRunScript>) => {
  const opened: Array<CursorAgentSdkOpenInput> = [];
  const messages: Array<unknown> = [];
  const cancelled: Array<string> = [];
  let runCount = 0;
  const runner: CursorAgentSdkRunnerShape = {
    assertComplete: Effect.void,
    open: (input) =>
      Effect.sync((): CursorAgentSdkSession => {
        opened.push(input);
        const agentId = input.agentId ?? "agent-created";
        return {
          agentId,
          listMessages: Effect.succeed([]),
          close: Effect.void,
          send: (sendInput) =>
            Effect.gen(function* () {
              messages.push(sendInput.message);
              const script = scripts.shift() ?? { updates: [] };
              runCount += 1;
              const runId = `run-${runCount}`;
              for (const update of script.updates) {
                yield* (sendInput.onDelta?.(update) ?? Effect.void).pipe(Effect.orDie);
              }
              return {
                runId,
                agentId,
                wait: script.wait ?? Effect.succeed({ id: runId, status: "finished" }),
                cancel: Effect.sync(() => {
                  cancelled.push(runId);
                }).pipe(Effect.andThen(script.onCancel ?? Effect.void)),
              };
            }),
        };
      }),
  };
  return { runner, opened, messages, cancelled };
};

/** Collects runtime events until the given number of turns complete. */
const collectEvents = Effect.fn("collectEvents")(function* (
  adapter: Effect.Success<ReturnType<typeof makeCursorAdapter>>,
  completedTurns: number,
) {
  const events: Array<ProviderRuntimeEvent> = [];
  const done = yield* Deferred.make<void>();
  let turns = 0;
  const fiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
    Effect.gen(function* () {
      events.push(event);
      if (event.type === "turn.completed" && ++turns === completedTurns) {
        yield* Deferred.succeed(done, undefined);
      }
    }),
  ).pipe(Effect.forkChild);
  yield* Effect.yieldNow;
  return {
    events,
    finished: Deferred.await(done).pipe(
      Effect.timeout("5 seconds"),
      Effect.andThen(Fiber.interrupt(fiber)),
    ),
  };
});

it.layer(testLayer)("CursorAdapter", (it) => {
  it.effect("maps one Cursor run onto V1 runtime events", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("cursor-run-events");
      const sdk = makeFakeRunner([
        {
          updates: [
            { type: "thinking-delta", text: "Checking the tree." },
            { type: "thinking-completed", thinkingDurationMs: 5 },
            {
              type: "tool-call-started",
              modelCallId: "model-call-1",
              callId: "call-shell",
              toolCall: { type: "shell", args: { command: "ls" } },
            },
            {
              type: "tool-call-completed",
              modelCallId: "model-call-1",
              callId: "call-shell",
              toolCall: {
                type: "shell",
                args: { command: "ls" },
                result: {
                  status: "success",
                  value: {
                    exitCode: 0,
                    signal: "",
                    stdout: "package.json\n",
                    stderr: "",
                    executionTime: 3,
                  },
                },
              },
            },
            {
              type: "tool-call-completed",
              modelCallId: "model-call-1",
              callId: "call-todos",
              toolCall: {
                type: "updateTodos",
                args: {
                  todos: [
                    { content: "Read files", status: "completed" },
                    { content: "Dropped", status: "cancelled" },
                    { content: "Write answer", status: "inProgress" },
                  ],
                },
              },
            },
            { type: "text-delta", text: "Found " },
            { type: "text-delta", text: "package.json." },
          ],
        },
      ]);
      const adapter = yield* makeCursorAdapter({ runner: sdk.runner, instanceId });
      const collected = yield* collectEvents(adapter, 1);

      const session = yield* adapter.startSession({
        threadId,
        provider,
        cwd: process.cwd(),
        modelSelection: { instanceId, model: "auto" },
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "What is here?" });
      yield* collected.finished;

      assert.deepStrictEqual(session.resumeCursor, { schemaVersion: 2, agentId: "agent-created" });
      const openInput = sdk.opened[0];
      assert.equal(openInput?.operation, "create");
      assert.deepStrictEqual(openInput?.options.model, { id: "default" });
      assert.deepInclude(openInput?.options.local, {
        cwd: process.cwd(),
        autoReview: false,
        sandboxOptions: { enabled: false },
        enableAgentRetries: true,
      });
      const message = sdk.messages[0];
      assert.isString(message);
      assert.isTrue(String(message).startsWith("What is here?\n\n"));

      const events = collected.events;
      const reasoning = events.find(
        (event) => event.type === "content.delta" && event.payload.streamKind === "reasoning_text",
      );
      assert.equal(
        reasoning?.type === "content.delta" && reasoning.payload.delta,
        "Checking the tree.",
      );
      const commandStarted = events.find(
        (event) => event.type === "item.started" && event.payload.itemType === "command_execution",
      );
      assert.equal(commandStarted?.type === "item.started" && commandStarted.payload.detail, "ls");
      const commandCompleted = events.find(
        (event) =>
          event.type === "item.completed" && event.payload.itemType === "command_execution",
      );
      assert.deepStrictEqual(
        commandCompleted?.type === "item.completed" && commandCompleted.payload.data,
        {
          toolCallId: "call-shell",
          kind: "execute",
          command: "ls",
          rawInput: { command: "ls" },
          rawOutput: { exitCode: 0, stdout: "package.json\n", stderr: "" },
        },
      );
      const plan = events.find((event) => event.type === "turn.plan.updated");
      assert.deepStrictEqual(plan?.type === "turn.plan.updated" && plan.payload.plan, [
        { step: "Read files", status: "completed" },
        { step: "Write answer", status: "inProgress" },
      ]);
      const reply = events
        .filter(
          (event) =>
            event.type === "content.delta" && event.payload.streamKind === "assistant_text",
        )
        .map((event) => (event.type === "content.delta" ? event.payload.delta : ""))
        .join("");
      assert.equal(reply, "Found package.json.");
      const completed = events.at(-1);
      assert.deepStrictEqual(completed?.type === "turn.completed" && completed.payload, {
        state: "completed",
      });
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("resumes saved Cursor agents and starts fresh for Cursor CLI cursors", () =>
    Effect.gen(function* () {
      const sdk = makeFakeRunner([]);
      const adapter = yield* makeCursorAdapter({ runner: sdk.runner, instanceId });

      const resumed = yield* adapter.startSession({
        threadId: ThreadId.make("cursor-resume-sdk"),
        cwd: process.cwd(),
        resumeCursor: { schemaVersion: 2, agentId: "agent-saved" },
        runtimeMode: "approval-required",
      });
      yield* adapter.startSession({
        threadId: ThreadId.make("cursor-resume-acp"),
        cwd: process.cwd(),
        resumeCursor: { schemaVersion: 1, sessionId: "acp-session" },
        runtimeMode: "full-access",
      });

      assert.deepStrictEqual(resumed.resumeCursor, { schemaVersion: 2, agentId: "agent-saved" });
      assert.deepStrictEqual(
        sdk.opened.map((input) => [input.operation, input.agentId]),
        [
          ["resume", "agent-saved"],
          ["create", undefined],
        ],
      );
      assert.deepInclude(sdk.opened[0]?.options.local, {
        autoReview: true,
        sandboxOptions: { enabled: true },
      });
      yield* adapter.stopAll();
    }),
  );

  it.effect("sends the compaction command without runtime instructions", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("cursor-compress");
      const sdk = makeFakeRunner([]);
      const adapter = yield* makeCursorAdapter({ runner: sdk.runner, instanceId });
      const collected = yield* collectEvents(adapter, 1);

      yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
      assert.deepStrictEqual(adapter.compaction, { type: "slash-command", command: "/compress" });
      yield* adapter.sendTurn({ threadId, input: "/compress" });
      yield* collected.finished;

      assert.deepStrictEqual(sdk.messages, ["/compress"]);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("fails a turn whose reply is only a Cursor transport error", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("cursor-transport-failure");
      const sdk = makeFakeRunner([
        {
          updates: [
            {
              type: "text-delta",
              text: "Error: ConnectError: [unavailable] upstream connect error",
            },
          ],
        },
      ]);
      const adapter = yield* makeCursorAdapter({ runner: sdk.runner, instanceId });
      const collected = yield* collectEvents(adapter, 1);

      yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
      yield* adapter.sendTurn({ threadId, input: "hello" });
      yield* collected.finished;

      const runtimeError = collected.events.find((event) => event.type === "runtime.error");
      assert.equal(
        runtimeError?.type === "runtime.error" && runtimeError.payload.class,
        "transport_error",
      );
      const completed = collected.events.at(-1);
      assert.deepStrictEqual(completed?.type === "turn.completed" && completed.payload, {
        state: "failed",
        errorMessage: "Error: ConnectError: [unavailable] upstream connect error",
      });
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("interrupts the running turn when a new message arrives", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("cursor-steer");
      const firstRunCancelled = yield* Deferred.make<void>();
      const sdk = makeFakeRunner([
        {
          updates: [{ type: "text-delta", text: "Working" }],
          wait: Deferred.await(firstRunCancelled).pipe(
            Effect.as({ id: "run-1", status: "cancelled" } satisfies RunResult),
          ),
          onCancel: Deferred.succeed(firstRunCancelled, undefined).pipe(Effect.asVoid),
        },
        { updates: [{ type: "text-delta", text: "Switched" }] },
      ]);
      const adapter = yield* makeCursorAdapter({ runner: sdk.runner, instanceId });
      const collected = yield* collectEvents(adapter, 2);

      yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
      const first = yield* adapter.sendTurn({ threadId, input: "Start" });
      const second = yield* adapter.sendTurn({ threadId, input: "Do this instead" });
      yield* collected.finished;

      assert.deepStrictEqual(sdk.cancelled, ["run-1"]);
      const lifecycle = collected.events.flatMap((event) =>
        event.type === "turn.started"
          ? [["started", event.turnId]]
          : event.type === "turn.completed"
            ? [[event.payload.state, event.turnId]]
            : [],
      );
      assert.deepStrictEqual(lifecycle, [
        ["started", first.turnId],
        ["interrupted", first.turnId],
        ["started", second.turnId],
        ["completed", second.turnId],
      ]);
      yield* adapter.stopSession(threadId);
    }),
  );
});
