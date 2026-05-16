import assert from "node:assert/strict";

import * as NodeServices from "@effect/platform-node/NodeServices";
import type {
  CopilotClient,
  CopilotSession,
  PermissionRequest,
  SessionConfig,
  SessionEvent,
} from "@github/copilot-sdk";
import { it } from "@effect/vitest";
import { Effect, Fiber, Layer, Stream } from "effect";
import { beforeEach, vi } from "vitest";

import { type ProviderRuntimeEvent, ProviderDriverKind, ThreadId } from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { CopilotAdapter } from "../Services/CopilotAdapter.ts";
import { makeCopilotAdapterLive } from "./CopilotAdapter.ts";

const asThreadId = (value: string): ThreadId => ThreadId.make(value);
const COPILOT_DRIVER = ProviderDriverKind.make("copilot");
const waitForSdkEventQueue = () =>
  Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 10)));

const runtimeMock = vi.hoisted(() => {
  const makeSession = () => ({
    sessionId: "copilot-sdk-session-1",
    rpc: {
      mode: {
        set: vi.fn(async () => undefined),
      },
      plan: {
        read: vi.fn(async () => ({ content: "" })),
      },
    },
    disconnect: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined),
    send: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
  });

  const state = {
    startCalls: 0,
    stopCalls: 0,
    createSessionConfigs: [] as SessionConfig[],
    createSessionImpl: null as ((config: SessionConfig) => Promise<CopilotSession>) | null,
    lastSession: makeSession(),
  };

  return {
    state,
    reset() {
      state.startCalls = 0;
      state.stopCalls = 0;
      state.createSessionConfigs.length = 0;
      state.lastSession = makeSession();
      state.createSessionImpl = async () => state.lastSession as unknown as CopilotSession;
    },
  };
});

vi.mock("../copilotRuntime.ts", async () => {
  const actual =
    await vi.importActual<typeof import("../copilotRuntime.ts")>("../copilotRuntime.ts");

  return {
    ...actual,
    createCopilotClient: vi.fn(
      () =>
        ({
          start: vi.fn(async () => {
            runtimeMock.state.startCalls += 1;
          }),
          stop: vi.fn(async () => {
            runtimeMock.state.stopCalls += 1;
          }),
          createSession: vi.fn(async (config: SessionConfig) => {
            runtimeMock.state.createSessionConfigs.push(config);
            return (runtimeMock.state.createSessionImpl ?? (async () => undefined as never))(
              config,
            );
          }),
          resumeSession: vi.fn(async () => {
            throw new Error("resumeSession is not used in CopilotAdapter tests");
          }),
        }) as unknown as CopilotClient,
    ),
  };
});

beforeEach(() => {
  runtimeMock.reset();
});

const CopilotAdapterTestLayer = makeCopilotAdapterLive().pipe(
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), {
      prefix: "t3code-copilot-adapter-test-",
    }),
  ),
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(CopilotAdapterTestLayer)("CopilotAdapterLive", (it) => {
  it.effect(
    "denies bootstrap permission requests before the session context exists in approval-required mode",
    () =>
      Effect.gen(function* () {
        runtimeMock.state.createSessionImpl = async (config) => {
          assert.ok(config.onPermissionRequest);
          const result = await config.onPermissionRequest({ kind: "shell" } as PermissionRequest, {
            sessionId: runtimeMock.state.lastSession.sessionId,
          });
          assert.deepStrictEqual(result, { kind: "denied-interactively-by-user" });
          return runtimeMock.state.lastSession as unknown as CopilotSession;
        };

        const adapter = yield* CopilotAdapter;
        const threadId = asThreadId("copilot-bootstrap-permission-denied");

        const session = yield* adapter.startSession({
          provider: COPILOT_DRIVER,
          threadId,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
        });

        assert.equal(session.provider, "copilot");
        yield* adapter.stopSession(threadId);
      }),
  );

  it.effect(
    "approves bootstrap permission requests before the session context exists in full-access mode",
    () =>
      Effect.gen(function* () {
        runtimeMock.state.createSessionImpl = async (config) => {
          assert.ok(config.onPermissionRequest);
          const result = await config.onPermissionRequest({ kind: "shell" } as PermissionRequest, {
            sessionId: runtimeMock.state.lastSession.sessionId,
          });
          assert.deepStrictEqual(result, { kind: "approved" });
          return runtimeMock.state.lastSession as unknown as CopilotSession;
        };

        const adapter = yield* CopilotAdapter;
        const threadId = asThreadId("copilot-bootstrap-permission-approved");

        const session = yield* adapter.startSession({
          provider: COPILOT_DRIVER,
          threadId,
          cwd: process.cwd(),
          runtimeMode: "full-access",
        });

        assert.equal(session.provider, "copilot");
        yield* adapter.stopSession(threadId);
      }),
  );

  it.effect(
    "returns an empty bootstrap user input response before the session context exists",
    () =>
      Effect.gen(function* () {
        runtimeMock.state.createSessionImpl = async (config) => {
          assert.ok(config.onUserInputRequest);
          const response = await config.onUserInputRequest(
            {
              question: "How should Copilot continue?",
              choices: ["Continue"],
              allowFreeform: true,
            },
            { sessionId: runtimeMock.state.lastSession.sessionId },
          );
          assert.deepStrictEqual(response, {
            answer: "",
            wasFreeform: true,
          });
          return runtimeMock.state.lastSession as unknown as CopilotSession;
        };

        const adapter = yield* CopilotAdapter;
        const threadId = asThreadId("copilot-bootstrap-user-input");

        const session = yield* adapter.startSession({
          provider: COPILOT_DRIVER,
          threadId,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
        });

        assert.equal(session.provider, "copilot");
        yield* adapter.stopSession(threadId);
      }),
  );

  it.effect(
    "renders Copilot Task_complete tool output as assistant text when no assistant message arrives",
    () =>
      Effect.gen(function* () {
        const adapter = yield* CopilotAdapter;
        const threadId = asThreadId("copilot-task-complete-assistant-fallback");

        yield* adapter.startSession({
          provider: COPILOT_DRIVER,
          threadId,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
        });

        const turn = yield* adapter.sendTurn({
          threadId,
          input: "make an architecture diagram",
          attachments: [],
        });

        const config = runtimeMock.state.createSessionConfigs.at(-1);
        assert.ok(config?.onEvent);
        const emit = (event: SessionEvent) => config.onEvent?.(event);
        const resultText =
          "Task completed: **Architecture diagram prepared**\n\n```mermaid\nflowchart TD\n  Client --> Server\n```";

        emit({
          id: "evt-copilot-turn-start",
          timestamp: new Date().toISOString(),
          parentId: null,
          type: "assistant.turn_start",
          data: {
            turnId: "sdk-turn-1",
          },
        } as SessionEvent);
        emit({
          id: "evt-copilot-task-start",
          timestamp: new Date().toISOString(),
          parentId: null,
          type: "tool.execution_start",
          data: {
            toolCallId: "tool-task-complete",
            toolName: "Task_complete",
            arguments: {},
          },
        } as SessionEvent);
        emit({
          id: "evt-copilot-task-complete",
          timestamp: new Date().toISOString(),
          parentId: null,
          type: "tool.execution_complete",
          data: {
            toolCallId: "tool-task-complete",
            success: true,
            result: {
              content: resultText,
            },
          },
        } as SessionEvent);
        emit({
          id: "evt-copilot-idle",
          timestamp: new Date().toISOString(),
          parentId: null,
          type: "session.idle",
          data: {
            aborted: false,
          },
        } as SessionEvent);

        let thread = yield* adapter.readThread(threadId);
        for (
          let attempt = 0;
          attempt < 20 &&
          !thread.turns.some((entry) =>
            entry.items.some(
              (item) =>
                typeof item === "object" &&
                item !== null &&
                "type" in item &&
                item.type === "assistant_message",
            ),
          );
          attempt += 1
        ) {
          yield* waitForSdkEventQueue();
          thread = yield* adapter.readThread(threadId);
        }

        const turnSnapshot = thread.turns.find((entry) => entry.id === turn.turnId);
        assert.ok(turnSnapshot);
        const assistantItem = turnSnapshot.items.find(
          (item) =>
            typeof item === "object" &&
            item !== null &&
            "type" in item &&
            item.type === "assistant_message",
        );
        assert.deepStrictEqual(assistantItem, {
          type: "assistant_message",
          messageId: `copilot-task-completion-${String(turn.turnId)}`,
          content: resultText,
        });

        yield* adapter.stopSession(threadId);
      }),
  );

  it.effect("renders a fallback assistant message when a tool-only turn completes", () =>
    Effect.gen(function* () {
      const adapter = yield* CopilotAdapter;
      const threadId = asThreadId("copilot-tool-only-assistant-fallback");

      yield* adapter.startSession({
        provider: COPILOT_DRIVER,
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });

      const turn = yield* adapter.sendTurn({
        threadId,
        input: "edit the docs",
        attachments: [],
      });

      const config = runtimeMock.state.createSessionConfigs.at(-1);
      assert.ok(config?.onEvent);
      const emit = (event: SessionEvent) => config.onEvent?.(event);
      const timestamp = yield* nowIso;

      emit({
        id: "evt-copilot-tool-only-turn-start",
        timestamp,
        parentId: null,
        type: "assistant.turn_start",
        data: {
          turnId: "sdk-turn-tool-only",
        },
      } as SessionEvent);
      emit({
        id: "evt-copilot-edit-start",
        timestamp,
        parentId: null,
        type: "tool.execution_start",
        data: {
          toolCallId: "tool-edit-file",
          toolName: "edit_file",
          arguments: {
            path: "README.md",
          },
        },
      } as SessionEvent);
      emit({
        id: "evt-copilot-edit-complete",
        timestamp,
        parentId: null,
        type: "tool.execution_complete",
        data: {
          toolCallId: "tool-edit-file",
          success: true,
          result: {},
        },
      } as SessionEvent);
      emit({
        id: "evt-copilot-tool-only-turn-end",
        timestamp,
        parentId: null,
        type: "assistant.turn_end",
        data: {
          turnId: "sdk-turn-tool-only",
        },
      } as SessionEvent);

      let thread = yield* adapter.readThread(threadId);
      for (
        let attempt = 0;
        attempt < 20 &&
        !thread.turns.some((entry) =>
          entry.items.some(
            (item) =>
              typeof item === "object" &&
              item !== null &&
              "type" in item &&
              item.type === "assistant_message",
          ),
        );
        attempt += 1
      ) {
        yield* waitForSdkEventQueue();
        thread = yield* adapter.readThread(threadId);
      }

      const turnSnapshot = thread.turns.find((entry) => entry.id === turn.turnId);
      assert.ok(turnSnapshot);
      const assistantItem = turnSnapshot.items.find(
        (item) =>
          typeof item === "object" &&
          item !== null &&
          "type" in item &&
          item.type === "assistant_message",
      );
      assert.deepStrictEqual(assistantItem, {
        type: "assistant_message",
        messageId: `copilot-tool-completion-${String(turn.turnId)}`,
        content: "Done. I completed the requested file changes.",
      });

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("ignores empty SDK tool progress messages without failing the session", () =>
    Effect.gen(function* () {
      const adapter = yield* CopilotAdapter;
      const threadId = asThreadId("copilot-sdk-event-queue-recovers-after-handler-failure");

      yield* adapter.startSession({
        provider: COPILOT_DRIVER,
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });

      const turn = yield* adapter.sendTurn({
        threadId,
        input: "finish even after a bad tool progress event",
        attachments: [],
      });

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) => Effect.sync(() => runtimeEvents.push(event))),
        Effect.forkChild,
      );
      yield* waitForSdkEventQueue();

      const config = runtimeMock.state.createSessionConfigs.at(-1);
      assert.ok(config?.onEvent);
      const emit = (event: SessionEvent) => config.onEvent?.(event);
      const timestamp = yield* nowIso;

      emit({
        id: "evt-copilot-turn-start-after-bad-event",
        timestamp,
        parentId: null,
        type: "assistant.turn_start",
        data: {
          turnId: "sdk-turn-bad-event",
        },
      } as SessionEvent);
      emit({
        id: "evt-copilot-bad-progress",
        timestamp,
        parentId: null,
        type: "tool.execution_progress",
        data: {
          toolCallId: "tool-progress-bad",
          progressMessage: null,
        },
      } as unknown as SessionEvent);
      emit({
        id: "evt-copilot-turn-end-after-bad-event",
        timestamp,
        parentId: null,
        type: "assistant.turn_end",
        data: {
          turnId: "sdk-turn-bad-event",
        },
      } as SessionEvent);

      let completed: ProviderRuntimeEvent | undefined;
      for (let attempt = 0; attempt < 20 && completed === undefined; attempt += 1) {
        yield* waitForSdkEventQueue();
        completed = runtimeEvents.find((event) => event.type === "turn.completed");
      }
      yield* Fiber.interrupt(runtimeEventsFiber).pipe(Effect.ignore);

      const runtimeError = runtimeEvents.find((event) => event.type === "runtime.error");
      const toolProgress = runtimeEvents.find((event) => event.type === "tool.progress");
      assert.equal(runtimeError, undefined);
      assert.equal(toolProgress, undefined);
      assert.equal(completed?.type, "turn.completed");
      if (completed?.type === "turn.completed") {
        assert.equal(String(completed.turnId), String(turn.turnId));
        assert.equal(completed.payload.state, "completed");
      }

      yield* adapter.stopSession(threadId);
    }),
  );
  it.effect("completes the turn as failed when Copilot send rejects", () =>
    Effect.gen(function* () {
      const adapter = yield* CopilotAdapter;
      const threadId = asThreadId("copilot-send-failure-turn-completed");

      yield* adapter.startSession({
        provider: COPILOT_DRIVER,
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });

      runtimeMock.state.lastSession.send.mockRejectedValueOnce(new Error("Copilot send rejected"));
      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) => Effect.sync(() => runtimeEvents.push(event))),
        Effect.forkChild,
      );
      yield* waitForSdkEventQueue();

      const result = yield* adapter
        .sendTurn({
          threadId,
          input: "trigger send failure",
          attachments: [],
        })
        .pipe(Effect.result);

      yield* waitForSdkEventQueue();
      yield* Fiber.interrupt(runtimeEventsFiber).pipe(Effect.ignore);

      assert.equal(result._tag, "Failure");
      const aborted = runtimeEvents.find((event) => event.type === "turn.aborted");
      const completed = runtimeEvents.find((event) => event.type === "turn.completed");

      assert.equal(aborted?.type, "turn.aborted");
      assert.equal(completed?.type, "turn.completed");
      if (aborted?.type === "turn.aborted" && completed?.type === "turn.completed") {
        assert.equal(String(completed.turnId), String(aborted.turnId));
        assert.equal(completed.payload.state, "failed");
        assert.equal(completed.payload.errorMessage, "Copilot send rejected");
      }

      yield* adapter.stopSession(threadId);
    }),
  );
});
