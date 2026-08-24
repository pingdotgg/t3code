// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeFSP from "node:fs/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  AgySettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import { makeAgyAdapter } from "./AgyAdapter.ts";

const decodeAgySettings = Schema.decodeSync(AgySettings);

async function makeMockAgyWrapper(options?: { readonly emitInit?: boolean }) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "agy-mock-"));
  const wrapperPath = NodePath.join(dir, "fake-agy.mjs");
  const script = `
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });

console.log("malformed native event");
if (${JSON.stringify(options?.emitInit !== false)}) {
  console.log(JSON.stringify({
    event: "init",
    conversation_id: "conv-12345",
    init: { cwd: process.cwd(), tools: ["run_command", "write_to_file"] }
  }));
}

rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.event === "user") {
    if (msg.message.content === "hang") return;
    if (msg.message.content === "crash") {
      process.exit(7);
      return;
    }
    // Emit step updates for user input, assistant response, and tool call
    console.log(JSON.stringify({
      event: "step_update",
      step_update: { step_index: 0, state: "DONE", step_type: "user_input" }
    }));
    console.log(JSON.stringify({
      event: "step_update",
      step_update: {
        step_index: 1,
        state: "ACTIVE",
        step_type: "agent_response",
        text_delta: "Hello from "
      }
    }));
    console.log(JSON.stringify({
      event: "step_update",
      step_update: {
        step_index: 2,
        state: "ACTIVE",
        step_type: "tool",
        tool_name: "run_command",
        tool_info: { name: "run_command", parameters: { command: "pwd" } }
      }
    }));
    console.log(JSON.stringify({
      event: "step_update",
      step_update: {
        step_index: 2,
        state: "DONE",
        step_type: "tool",
        tool_name: "run_command",
        tool_info: { name: "run_command" },
        output: "/tmp/project"
      }
    }));
    console.log(JSON.stringify({
      event: "step_update",
      step_update: {
        step_index: 1,
        state: "DONE",
        step_type: "agent_response",
        text_delta: "mock agy!"
      }
    }));
    console.log(JSON.stringify({
      event: "result",
      result: {
        conversation_id: "conv-12345",
        status: "SUCCESS",
        response: "Hello from mock agy!",
        num_turns: 1,
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }
      }
    }));
  }
});
`;
  await NodeFSP.writeFile(wrapperPath, script, "utf8");

  const shPath = NodePath.join(dir, "fake-agy.sh");
  const argsPath = NodePath.join(dir, "args.log");
  await NodeFSP.writeFile(
    shPath,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> ${JSON.stringify(argsPath)}`,
      `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(wrapperPath)} "$@"`,
      "",
    ].join("\n"),
    "utf8",
  );
  await NodeFSP.chmod(shPath, 0o755);
  return { binaryPath: shPath, argsPath, dir };
}

const agyAdapterTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-agy-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

describe("AgyAdapter", () => {
  it.layer(agyAdapterTestLayer)(
    "starts a session, sends a turn, and receives streamed events",
    (it) => {
      it.effect("completes a full turn cycle", () =>
        Effect.gen(function* () {
          const mock = yield* Effect.promise(() => makeMockAgyWrapper());
          const adapter = yield* makeAgyAdapter(
            decodeAgySettings({ binaryPath: mock.binaryPath, launchArgs: "--agent reviewer" }),
          );

          const threadId = ThreadId.make("thread-1");

          const receivedEvents: Array<ProviderRuntimeEvent> = [];
          const turnCompletions =
            yield* Queue.unbounded<Extract<ProviderRuntimeEvent, { type: "turn.completed" }>>();

          const eventFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
            Effect.sync(() => {
              receivedEvents.push(event);
            }).pipe(
              Effect.andThen(
                event.type === "turn.completed" ? Queue.offer(turnCompletions, event) : Effect.void,
              ),
            ),
          ).pipe(Effect.forkChild);

          const session = yield* adapter.startSession({
            threadId,
            cwd: process.cwd(),
            runtimeMode: "full-access",
            modelSelection: {
              instanceId: ProviderInstanceId.make("agy"),
              model: "gemini-3.7-flash-high",
              options: [{ id: "reasoningEffort", value: "low" }],
            },
          });

          expect(session.threadId).toBe(threadId);
          expect(session.provider).toBe(ProviderDriverKind.make("agy"));
          expect(yield* adapter.hasSession(threadId)).toBe(true);

          const result = yield* adapter.sendTurn({
            threadId,
            input: "Say hello",
          });

          expect(result.threadId).toBe(threadId);
          expect(result.turnId).toBeTruthy();
          expect(result.resumeCursor).toEqual({
            schemaVersion: 1,
            conversationId: "conv-12345",
          });

          yield* Queue.take(turnCompletions);

          const turnCompletedEvent = receivedEvents.find((e) => e.type === "turn.completed");
          expect(turnCompletedEvent).toBeDefined();
          if (turnCompletedEvent && turnCompletedEvent.type === "turn.completed") {
            expect(turnCompletedEvent.payload.state).toBe("completed");
            expect(turnCompletedEvent.payload.usage).toEqual({
              inputTokens: 10,
              outputTokens: 5,
              totalTokens: 15,
            });
          }

          const deltaEvents = receivedEvents.filter((e) => e.type === "content.delta");
          expect(deltaEvents.length).toBeGreaterThan(0);
          expect(
            receivedEvents.some(
              (event) =>
                event.type === "item.completed" &&
                event.payload.itemType === "command_execution" &&
                event.payload.status === "completed",
            ),
          ).toBe(true);

          const secondResult = yield* adapter.sendTurn({
            threadId,
            input: "Say hello again",
            interactionMode: "plan",
          });
          yield* Queue.take(turnCompletions);
          expect(secondResult.turnId).not.toBe(result.turnId);

          const switchedResult = yield* adapter.sendTurn({
            threadId,
            input: "Use the medium model",
            interactionMode: "plan",
            modelSelection: {
              instanceId: ProviderInstanceId.make("agy"),
              model: "gemini-3.7-flash-high",
              options: [{ id: "reasoningEffort", value: "medium" }],
            },
          });
          yield* Queue.take(turnCompletions);
          expect(switchedResult.turnId).not.toBe(secondResult.turnId);

          yield* adapter.sendTurn({
            threadId,
            input: "Use the default model",
            interactionMode: "plan",
            modelSelection: { instanceId: ProviderInstanceId.make("agy"), model: "" },
          });
          yield* Queue.take(turnCompletions);
          expect((yield* adapter.listSessions())[0]?.model).toBeUndefined();

          const snapshot = yield* adapter.readThread(threadId);
          expect(snapshot.threadId).toBe(threadId);
          expect(snapshot.turns).toHaveLength(4);
          expect(snapshot.turns.every((turn) => turn.items.length > 0)).toBe(true);
          const rollbackError = yield* adapter.rollbackThread(threadId, 1).pipe(Effect.flip);
          expect(rollbackError.message).toContain("do not support provider-side rollback");

          const invocations = yield* Effect.promise(() => NodeFSP.readFile(mock.argsPath, "utf8"));
          expect(invocations).toContain("--dangerously-skip-permissions");
          expect(invocations).toContain("--mode accept-edits");
          expect(invocations).toContain("--mode plan");
          expect(invocations).toContain("--agent reviewer");
          expect(invocations).toContain("--conversation conv-12345");
          expect(invocations).toContain("--model gemini-3.7-flash-low --effort low");
          expect(invocations).toContain("--model gemini-3.7-flash-medium --effort medium");
          expect(adapter.capabilities.sessionModelSwitch).toBe("in-session");

          yield* adapter.stopSession(threadId);
          expect(yield* adapter.hasSession(threadId)).toBe(false);

          yield* Fiber.interrupt(eventFiber);
          yield* Effect.promise(() => NodeFSP.rm(mock.dir, { recursive: true, force: true }));
        }),
      );

      it.effect("uses the sandbox for non-full-access sessions", () =>
        Effect.gen(function* () {
          const mock = yield* Effect.promise(() => makeMockAgyWrapper());
          const adapter = yield* makeAgyAdapter(decodeAgySettings({ binaryPath: mock.binaryPath }));
          const threadId = ThreadId.make("thread-sandbox");

          yield* adapter.startSession({
            threadId,
            cwd: process.cwd(),
            runtimeMode: "approval-required",
          });
          yield* adapter.sendTurn({ threadId, input: "Inspect safely" });

          const invocation = yield* Effect.promise(() => NodeFSP.readFile(mock.argsPath, "utf8"));
          expect(invocation).toContain("--sandbox");
          expect(invocation).not.toContain("--dangerously-skip-permissions");

          yield* adapter.stopSession(threadId);
          yield* Effect.promise(() => NodeFSP.rm(mock.dir, { recursive: true, force: true }));
        }),
      );

      it.effect("closes the turn and restores the session when initialization times out", () =>
        Effect.gen(function* () {
          const mock = yield* Effect.promise(() => makeMockAgyWrapper({ emitInit: false }));
          const adapter = yield* makeAgyAdapter(decodeAgySettings({ binaryPath: mock.binaryPath }));
          const threadId = ThreadId.make("thread-init-timeout");
          const receivedEvents: Array<ProviderRuntimeEvent> = [];
          const eventFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
            Effect.sync(() => receivedEvents.push(event)),
          ).pipe(Effect.forkChild);

          yield* adapter.startSession({
            threadId,
            cwd: process.cwd(),
            runtimeMode: "full-access",
          });
          const sendFiber = yield* adapter
            .sendTurn({ threadId, input: "Wait for initialization" })
            .pipe(Effect.flip, Effect.forkChild);
          yield* TestClock.adjust("10 seconds");
          const error = yield* Fiber.join(sendFiber);

          expect(error.message).toContain("did not initialize");
          expect((yield* adapter.listSessions())[0]?.status).toBe("ready");
          expect(
            receivedEvents.some(
              (event) => event.type === "turn.completed" && event.payload.state === "failed",
            ),
          ).toBe(true);
          expect(
            receivedEvents.some(
              (event) => event.type === "session.state.changed" && event.payload.state === "ready",
            ),
          ).toBe(true);

          yield* adapter.stopSession(threadId);
          yield* Fiber.interrupt(eventFiber);
          yield* Effect.promise(() => NodeFSP.rm(mock.dir, { recursive: true, force: true }));
        }),
      );

      it.effect("interrupts an active turn and keeps the session ready", () =>
        Effect.gen(function* () {
          const mock = yield* Effect.promise(() => makeMockAgyWrapper());
          const adapter = yield* makeAgyAdapter(decodeAgySettings({ binaryPath: mock.binaryPath }));
          const threadId = ThreadId.make("thread-interrupt");
          const completions =
            yield* Queue.unbounded<Extract<ProviderRuntimeEvent, { type: "turn.completed" }>>();
          const eventFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
            event.type === "turn.completed" ? Queue.offer(completions, event) : Effect.void,
          ).pipe(Effect.forkChild);

          yield* adapter.startSession({
            threadId,
            cwd: process.cwd(),
            runtimeMode: "full-access",
          });
          const turn = yield* adapter.sendTurn({ threadId, input: "hang" });
          yield* adapter.interruptTurn(threadId, turn.turnId);

          expect((yield* Queue.take(completions)).payload.state).toBe("interrupted");
          expect((yield* adapter.listSessions())[0]?.status).toBe("ready");

          const activeTurn = yield* adapter.sendTurn({ threadId, input: "hang" });
          yield* adapter.interruptTurn(threadId, turn.turnId);
          expect((yield* adapter.listSessions())[0]?.status).toBe("running");
          expect((yield* adapter.listSessions())[0]?.activeTurnId).toBe(activeTurn.turnId);

          yield* adapter.interruptTurn(threadId, activeTurn.turnId);
          expect((yield* Queue.take(completions)).payload.state).toBe("interrupted");
          expect((yield* adapter.listSessions())[0]?.status).toBe("ready");

          yield* adapter.stopSession(threadId);
          yield* Fiber.interrupt(eventFiber);
          yield* Effect.promise(() => NodeFSP.rm(mock.dir, { recursive: true, force: true }));
        }),
      );

      it.effect("fails the active turn when the CLI exits unexpectedly", () =>
        Effect.gen(function* () {
          const mock = yield* Effect.promise(() => makeMockAgyWrapper());
          const adapter = yield* makeAgyAdapter(decodeAgySettings({ binaryPath: mock.binaryPath }));
          const threadId = ThreadId.make("thread-crash");
          const completions =
            yield* Queue.unbounded<Extract<ProviderRuntimeEvent, { type: "turn.completed" }>>();
          const eventFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
            event.type === "turn.completed" ? Queue.offer(completions, event) : Effect.void,
          ).pipe(Effect.forkChild);

          yield* adapter.startSession({
            threadId,
            cwd: process.cwd(),
            runtimeMode: "full-access",
          });
          yield* adapter.sendTurn({ threadId, input: "crash" });

          const completed = yield* Queue.take(completions);
          expect(completed.payload.state).toBe("failed");
          expect(completed.payload.errorMessage).toContain("exited before the turn completed");
          expect((yield* adapter.listSessions())[0]?.status).toBe("error");

          yield* adapter.stopSession(threadId);
          yield* Fiber.interrupt(eventFiber);
          yield* Effect.promise(() => NodeFSP.rm(mock.dir, { recursive: true, force: true }));
        }),
      );
    },
  );
});
