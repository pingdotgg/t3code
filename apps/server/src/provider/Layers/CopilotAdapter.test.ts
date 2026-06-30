import * as NodeAssert from "node:assert/strict";
import * as NodeTimersPromises from "node:timers/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import type {
  CopilotClient,
  CopilotSession,
  PermissionRequest,
  SessionConfig,
  SessionEvent,
} from "@github/copilot-sdk";
import { beforeEach, it } from "@effect/vitest";
import { Context, DateTime, Effect, Fiber, Layer, Schema, Stream } from "effect";
import { vi } from "vite-plus/test";

import {
  ApprovalRequestId,
  CopilotSettings,
  type ProviderRuntimeEvent,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import type { CopilotAdapterShape } from "../Services/CopilotAdapter.ts";
import { type EventNdjsonLogger } from "./EventNdjsonLogger.ts";
import { makeCopilotAdapter } from "./CopilotAdapter.ts";

const decodeCopilotSettings = Schema.decodeSync(CopilotSettings);

class CopilotAdapter extends Context.Service<CopilotAdapter, CopilotAdapterShape>()(
  "t3/provider/Layers/CopilotAdapter.test/CopilotAdapter",
) {}

const asThreadId = (value: string): ThreadId => ThreadId.make(value);
const COPILOT_DRIVER = ProviderDriverKind.make("copilot");
const COPILOT_INSTANCE_ID = ProviderInstanceId.make("copilot");
const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
const waitForSdkEventQueue = () =>
  Effect.promise(() => NodeTimersPromises.setTimeout(10).then(() => undefined));

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
      backgroundTasks: {
        list: vi.fn(
          async (): Promise<{ tasks: Array<Record<string, unknown>> }> => ({
            tasks: [],
          }),
        ),
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
    nativeWriteCalls: 0,
    nativeWriteGate: null as Promise<void> | null,
    createSessionConfigs: [] as SessionConfig[],
    resumeSessionCalls: [] as Array<{ readonly sessionId: string; readonly config: SessionConfig }>,
    createSessionImpl: null as ((config: SessionConfig) => Promise<CopilotSession>) | null,
    resumeSessionImpl: null as
      | ((sessionId: string, config: SessionConfig) => Promise<CopilotSession>)
      | null,
    lastSession: makeSession(),
  };

  return {
    state,
    reset() {
      state.startCalls = 0;
      state.stopCalls = 0;
      state.nativeWriteCalls = 0;
      state.nativeWriteGate = null;
      state.createSessionConfigs.length = 0;
      state.resumeSessionCalls.length = 0;
      state.lastSession = makeSession();
      state.createSessionImpl = async () => state.lastSession as unknown as CopilotSession;
      state.resumeSessionImpl = async () => state.lastSession as unknown as CopilotSession;
    },
  };
});

vi.mock("../copilotRuntime.ts", async () => {
  const actual =
    await vi.importActual<typeof import("../copilotRuntime.ts")>("../copilotRuntime.ts");

  return {
    ...actual,
    createCopilotClient: vi.fn(() =>
      Effect.succeed({
        start: vi.fn(async () => {
          runtimeMock.state.startCalls += 1;
        }),
        stop: vi.fn(async () => {
          runtimeMock.state.stopCalls += 1;
        }),
        createSession: vi.fn(async (config: SessionConfig) => {
          runtimeMock.state.createSessionConfigs.push(config);
          return (runtimeMock.state.createSessionImpl ?? (async () => undefined as never))(config);
        }),
        resumeSession: vi.fn(async (sessionId: string, config: SessionConfig) => {
          runtimeMock.state.resumeSessionCalls.push({ sessionId, config });
          return (runtimeMock.state.resumeSessionImpl ?? (async () => undefined as never))(
            sessionId,
            config,
          );
        }),
      } as unknown as CopilotClient),
    ),
  };
});

beforeEach(() => {
  runtimeMock.reset();
});

const nativeEventLogger = {
  filePath: "memory://copilot-native-events.ndjson",
  write: vi.fn(() =>
    Effect.promise(async () => {
      runtimeMock.state.nativeWriteCalls += 1;
      const gate = runtimeMock.state.nativeWriteGate;
      if (gate) {
        await gate;
      }
    }),
  ),
  close: vi.fn(() => Effect.void),
} satisfies EventNdjsonLogger;

const CopilotAdapterTestLayer = Layer.effect(
  CopilotAdapter,
  makeCopilotAdapter(decodeCopilotSettings({}), { nativeEventLogger }),
).pipe(
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), {
      prefix: "t3code-copilot-adapter-test-",
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(CopilotAdapterTestLayer)("CopilotAdapterLive", (it) => {
  it.effect(
    "denies bootstrap permission requests before the session context exists in approval-required mode",
    () =>
      Effect.gen(function* () {
        runtimeMock.state.createSessionImpl = async (config: SessionConfig) => {
          NodeAssert.ok(config.onPermissionRequest);
          const result = await config.onPermissionRequest({ kind: "shell" } as PermissionRequest, {
            sessionId: runtimeMock.state.lastSession.sessionId,
          });
          NodeAssert.deepStrictEqual(result, { kind: "reject" });
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

        NodeAssert.equal(session.provider, "copilot");
        yield* adapter.stopSession(threadId);
      }),
  );

  it.effect(
    "approves bootstrap permission requests before the session context exists in full-access mode",
    () =>
      Effect.gen(function* () {
        runtimeMock.state.createSessionImpl = async (config: SessionConfig) => {
          NodeAssert.ok(config.onPermissionRequest);
          const result = await config.onPermissionRequest({ kind: "shell" } as PermissionRequest, {
            sessionId: runtimeMock.state.lastSession.sessionId,
          });
          NodeAssert.deepStrictEqual(result, { kind: "approve-once" });
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

        NodeAssert.equal(session.provider, "copilot");
        yield* adapter.stopSession(threadId);
      }),
  );

  it.effect("only approves bootstrap edit permission requests in auto-accept-edits mode", () =>
    Effect.gen(function* () {
      runtimeMock.state.createSessionImpl = async (config: SessionConfig) => {
        NodeAssert.ok(config.onPermissionRequest);
        const shellResult = await config.onPermissionRequest(
          { kind: "shell" } as PermissionRequest,
          {
            sessionId: runtimeMock.state.lastSession.sessionId,
          },
        );
        const writeResult = await config.onPermissionRequest(
          { kind: "write" } as PermissionRequest,
          {
            sessionId: runtimeMock.state.lastSession.sessionId,
          },
        );
        NodeAssert.deepStrictEqual(shellResult, { kind: "reject" });
        NodeAssert.deepStrictEqual(writeResult, { kind: "approve-once" });
        return runtimeMock.state.lastSession as unknown as CopilotSession;
      };

      const adapter = yield* CopilotAdapter;
      const threadId = asThreadId("copilot-bootstrap-auto-accept-edits");

      const session = yield* adapter.startSession({
        provider: COPILOT_DRIVER,
        threadId,
        cwd: process.cwd(),
        runtimeMode: "auto-accept-edits",
      });

      NodeAssert.equal(session.provider, "copilot");
      NodeAssert.deepStrictEqual(runtimeMock.state.lastSession.rpc.mode.set.mock.calls.at(-1), [
        { mode: "interactive" },
      ]);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect(
    "returns an empty bootstrap user input response before the session context exists",
    () =>
      Effect.gen(function* () {
        runtimeMock.state.createSessionImpl = async (config: SessionConfig) => {
          NodeAssert.ok(config.onUserInputRequest);
          const response = await config.onUserInputRequest(
            {
              question: "How should Copilot continue?",
              choices: ["Continue"],
              allowFreeform: true,
            },
            { sessionId: runtimeMock.state.lastSession.sessionId },
          );
          NodeAssert.deepStrictEqual(response, {
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

        NodeAssert.equal(session.provider, "copilot");
        yield* adapter.stopSession(threadId);
      }),
  );

  it.effect("emits canonical answer maps for completed Copilot user input", () =>
    Effect.gen(function* () {
      const adapter = yield* CopilotAdapter;
      const threadId = asThreadId("copilot-user-input-canonical-answers");

      yield* adapter.startSession({
        provider: COPILOT_DRIVER,
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) => Effect.sync(() => runtimeEvents.push(event))),
        Effect.forkChild,
      );
      yield* waitForSdkEventQueue();

      const config = runtimeMock.state.createSessionConfigs.at(-1);
      NodeAssert.ok(config?.onEvent);
      NodeAssert.ok(config.onUserInputRequest);
      const emit = (event: SessionEvent) => config.onEvent?.(event);
      const timestamp = yield* nowIso;
      const requestId = "user-input-canonical-answer";
      const request = {
        question: "How should Copilot continue?",
        choices: ["Use default"],
        allowFreeform: true,
      };

      const responsePromise = Promise.resolve(
        config.onUserInputRequest(request, {
          sessionId: runtimeMock.state.lastSession.sessionId,
        }),
      );
      emit({
        id: "evt-copilot-user-input-requested",
        timestamp,
        parentId: null,
        type: "user_input.requested",
        data: {
          requestId,
          ...request,
        },
      } as SessionEvent);

      let requested: ProviderRuntimeEvent | undefined;
      for (let attempt = 0; attempt < 20 && requested === undefined; attempt += 1) {
        yield* waitForSdkEventQueue();
        requested = runtimeEvents.find(
          (event) => event.type === "user-input.requested" && String(event.requestId) === requestId,
        );
      }
      NodeAssert.equal(requested?.type, "user-input.requested");
      if (requested?.type === "user-input.requested") {
        NodeAssert.equal(requested.providerRefs?.providerRequestId, requestId);
      }

      yield* adapter.respondToUserInput(threadId, ApprovalRequestId.make(requestId), {
        answer: "Use a custom answer",
      });
      const response = yield* Effect.promise(() => responsePromise);
      NodeAssert.deepStrictEqual(response, {
        answer: "Use a custom answer",
        wasFreeform: true,
      });

      let resolved: ProviderRuntimeEvent | undefined;
      for (let attempt = 0; attempt < 20 && resolved === undefined; attempt += 1) {
        yield* waitForSdkEventQueue();
        resolved = runtimeEvents.find(
          (event) => event.type === "user-input.resolved" && String(event.requestId) === requestId,
        );
      }
      yield* Fiber.interrupt(runtimeEventsFiber).pipe(Effect.ignore);

      NodeAssert.equal(resolved?.type, "user-input.resolved");
      if (resolved?.type === "user-input.resolved") {
        NodeAssert.equal(resolved.providerRefs?.providerRequestId, requestId);
        NodeAssert.deepStrictEqual(resolved.payload.answers, {
          answer: "Use a custom answer",
        });
        NodeAssert.equal("wasFreeform" in resolved.payload.answers, false);
      }

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("coerces fixed-choice Copilot user input to an allowed answer", () =>
    Effect.gen(function* () {
      const adapter = yield* CopilotAdapter;
      const threadId = asThreadId("copilot-user-input-fixed-choice");

      yield* adapter.startSession({
        provider: COPILOT_DRIVER,
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });

      const config = runtimeMock.state.createSessionConfigs.at(-1);
      NodeAssert.ok(config?.onEvent);
      NodeAssert.ok(config.onUserInputRequest);
      const requestId = "user-input-fixed-choice";
      const request = {
        question: "How should Copilot continue?",
        choices: ["Use default", "Stop"],
        allowFreeform: false,
      };
      const responsePromise = Promise.resolve(
        config.onUserInputRequest(request, {
          sessionId: runtimeMock.state.lastSession.sessionId,
        }),
      );
      const timestamp = yield* nowIso;

      config.onEvent({
        id: "evt-copilot-user-input-fixed-choice",
        timestamp,
        parentId: null,
        type: "user_input.requested",
        data: {
          requestId,
          ...request,
        },
      } as SessionEvent);
      yield* waitForSdkEventQueue();

      yield* adapter.respondToUserInput(threadId, ApprovalRequestId.make(requestId), {
        answer: "Unlisted answer",
      });

      const response = yield* Effect.promise(() => responsePromise);
      NodeAssert.deepStrictEqual(response, {
        answer: "Use default",
        wasFreeform: false,
      });

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("passes selected Copilot context tier when creating a session", () =>
    Effect.gen(function* () {
      const adapter = yield* CopilotAdapter;
      const threadId = asThreadId("copilot-start-session-context-tier");

      yield* adapter.startSession({
        provider: COPILOT_DRIVER,
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
        modelSelection: {
          instanceId: COPILOT_INSTANCE_ID,
          model: "claude-sonnet-4.6",
          options: [
            { id: "reasoningEffort", value: "high" },
            { id: "contextTier", value: "long_context" },
          ],
        },
      });

      const config = runtimeMock.state.createSessionConfigs.at(-1);
      NodeAssert.equal(config?.model, "claude-sonnet-4.6");
      NodeAssert.equal(config?.reasoningEffort, "high");
      NodeAssert.equal(config?.contextTier, "long_context");

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("starts a fresh session when the persisted Copilot resume cursor is missing", () =>
    Effect.gen(function* () {
      runtimeMock.state.resumeSessionImpl = async (sessionId: string) => {
        throw new Error(
          `Request session.resume failed with message: Session not found: ${sessionId}`,
        );
      };
      const adapter = yield* CopilotAdapter;
      const threadId = asThreadId("copilot-stale-resume-cursor");

      const session = yield* adapter.startSession({
        provider: COPILOT_DRIVER,
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
        resumeCursor: {
          schemaVersion: 1,
          sessionId: "missing-copilot-session",
        },
      });

      NodeAssert.equal(runtimeMock.state.resumeSessionCalls.length, 1);
      NodeAssert.equal(
        runtimeMock.state.resumeSessionCalls[0]?.sessionId,
        "missing-copilot-session",
      );
      NodeAssert.equal(runtimeMock.state.createSessionConfigs.length, 1);
      NodeAssert.equal(runtimeMock.state.createSessionConfigs[0]?.sessionId, threadId);
      NodeAssert.deepEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: runtimeMock.state.lastSession.sessionId,
      });

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("passes selected Copilot context tier when changing models for a turn", () =>
    Effect.gen(function* () {
      const adapter = yield* CopilotAdapter;
      const threadId = asThreadId("copilot-send-turn-context-tier");

      yield* adapter.startSession({
        provider: COPILOT_DRIVER,
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });

      runtimeMock.state.lastSession.setModel.mockClear();
      yield* adapter.sendTurn({
        threadId,
        input: "Use the long context tier",
        attachments: [],
        modelSelection: {
          instanceId: COPILOT_INSTANCE_ID,
          model: "claude-sonnet-4.6",
          options: [{ id: "contextTier", value: "long_context" }],
        },
      });

      NodeAssert.deepStrictEqual(runtimeMock.state.lastSession.setModel.mock.calls.at(-1), [
        "claude-sonnet-4.6",
        { contextTier: "long_context" },
      ]);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("returns a session-scoped SDK approval for acceptForSession", () =>
    Effect.gen(function* () {
      const adapter = yield* CopilotAdapter;
      const threadId = asThreadId("copilot-permission-accept-for-session");

      yield* adapter.startSession({
        provider: COPILOT_DRIVER,
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) => Effect.sync(() => runtimeEvents.push(event))),
        Effect.forkChild,
      );
      yield* waitForSdkEventQueue();

      const config = runtimeMock.state.createSessionConfigs.at(-1);
      NodeAssert.ok(config?.onEvent);
      NodeAssert.ok(config.onPermissionRequest);

      const permissionRequest: PermissionRequest = {
        kind: "shell",
        toolCallId: "tool-shell-session-approval",
        fullCommandText: "git status",
        intention: "Check repository status",
        commands: [{ identifier: "git", readOnly: true }],
        possiblePaths: [],
        possibleUrls: [],
        hasWriteFileRedirection: false,
        canOfferSessionApproval: true,
      };
      const requestId = "permission-shell-session-approval";
      const resultPromise = Promise.resolve(
        config.onPermissionRequest(permissionRequest, {
          sessionId: runtimeMock.state.lastSession.sessionId,
        }),
      );
      const timestamp = yield* nowIso;

      config.onEvent({
        id: "evt-copilot-permission-session-approval",
        timestamp,
        parentId: null,
        type: "permission.requested",
        data: {
          requestId,
          permissionRequest,
          promptRequest: {
            kind: "commands",
            toolCallId: "tool-shell-session-approval",
            fullCommandText: "git status",
            intention: "Check repository status",
            commandIdentifiers: ["git"],
            canOfferSessionApproval: true,
          },
        },
      } as SessionEvent);
      yield* waitForSdkEventQueue();

      yield* adapter.respondToRequest(
        threadId,
        ApprovalRequestId.make(requestId),
        "acceptForSession",
      );

      const result = yield* Effect.promise(() => resultPromise);
      NodeAssert.deepStrictEqual(result, {
        kind: "approve-for-session",
        approval: {
          kind: "commands",
          commandIdentifiers: ["git"],
        },
      });

      let requestResolved: ProviderRuntimeEvent | undefined;
      for (let attempt = 0; attempt < 20 && requestResolved === undefined; attempt += 1) {
        yield* waitForSdkEventQueue();
        requestResolved = runtimeEvents.find(
          (event) => event.type === "request.resolved" && String(event.requestId) === requestId,
        );
      }
      NodeAssert.equal(requestResolved?.type, "request.resolved");
      if (requestResolved?.type === "request.resolved") {
        NodeAssert.equal(requestResolved.payload.requestType, "command_execution_approval");
        NodeAssert.equal(requestResolved.payload.decision, "acceptForSession");
        NodeAssert.deepStrictEqual(requestResolved.payload.resolution, result);
      }

      config.onEvent({
        id: "evt-copilot-permission-session-approval-completed",
        timestamp,
        parentId: null,
        type: "permission.completed",
        data: {
          requestId,
          result,
        },
      } as SessionEvent);
      yield* waitForSdkEventQueue();
      const resolvedEvents = runtimeEvents.filter(
        (event) => event.type === "request.resolved" && String(event.requestId) === requestId,
      );
      NodeAssert.equal(resolvedEvents.length, 1);

      const duplicateReply = yield* Effect.flip(
        adapter.respondToRequest(threadId, ApprovalRequestId.make(requestId), "acceptForSession"),
      );
      NodeAssert.match(duplicateReply.message, /Unknown pending permission request/);

      yield* Fiber.interrupt(runtimeEventsFiber).pipe(Effect.ignore);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("returns SDK session approval without path prompt approval for reads", () =>
    Effect.gen(function* () {
      const adapter = yield* CopilotAdapter;
      const threadId = asThreadId("copilot-read-permission-accept-for-session");

      yield* adapter.startSession({
        provider: COPILOT_DRIVER,
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });

      const config = runtimeMock.state.createSessionConfigs.at(-1);
      NodeAssert.ok(config?.onEvent);
      NodeAssert.ok(config.onPermissionRequest);

      const permissionRequest: PermissionRequest = {
        kind: "read",
        path: "README.md",
        intention: "Read project docs",
      };
      const requestId = "permission-read-session-approval";
      const resultPromise = Promise.resolve(
        config.onPermissionRequest(permissionRequest, {
          sessionId: runtimeMock.state.lastSession.sessionId,
        }),
      );
      const timestamp = yield* nowIso;

      config.onEvent({
        id: "evt-copilot-read-permission-session-approval",
        timestamp,
        parentId: null,
        type: "permission.requested",
        data: {
          requestId,
          permissionRequest,
        },
      } as SessionEvent);
      yield* waitForSdkEventQueue();

      yield* adapter.respondToRequest(
        threadId,
        ApprovalRequestId.make(requestId),
        "acceptForSession",
      );

      const result = yield* Effect.promise(() => resultPromise);
      NodeAssert.deepStrictEqual(result, { kind: "approve-for-session" });

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("returns a session-scoped SDK domain approval for URL acceptForSession", () =>
    Effect.gen(function* () {
      const adapter = yield* CopilotAdapter;
      const threadId = asThreadId("copilot-url-permission-accept-for-session");

      yield* adapter.startSession({
        provider: COPILOT_DRIVER,
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });

      const config = runtimeMock.state.createSessionConfigs.at(-1);
      NodeAssert.ok(config?.onEvent);
      NodeAssert.ok(config.onPermissionRequest);

      const permissionRequest: PermissionRequest = {
        kind: "url",
        toolCallId: "tool-url-session-approval",
        url: "https://docs.github.com/en/copilot",
        intention: "Fetch Copilot documentation",
      };
      const requestId = "permission-url-session-approval";
      const resultPromise = Promise.resolve(
        config.onPermissionRequest(permissionRequest, {
          sessionId: runtimeMock.state.lastSession.sessionId,
        }),
      );
      const timestamp = yield* nowIso;

      config.onEvent({
        id: "evt-copilot-url-permission-session-approval",
        timestamp,
        parentId: null,
        type: "permission.requested",
        data: {
          requestId,
          permissionRequest,
        },
      } as SessionEvent);
      yield* waitForSdkEventQueue();

      yield* adapter.respondToRequest(
        threadId,
        ApprovalRequestId.make(requestId),
        "acceptForSession",
      );

      const result = yield* Effect.promise(() => resultPromise);
      NodeAssert.deepStrictEqual(result, {
        kind: "approve-for-session",
        domain: "docs.github.com",
      });

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("renders Copilot Task_complete output as assistant text instead of a tool call", () =>
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

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) => Effect.sync(() => runtimeEvents.push(event))),
        Effect.forkChild,
      );
      yield* waitForSdkEventQueue();

      const config = runtimeMock.state.createSessionConfigs.at(-1);
      NodeAssert.ok(config?.onEvent);
      const emit = (event: SessionEvent) => config.onEvent?.(event);
      const resultText =
        "Task completed: **Architecture diagram prepared**\n\n```mermaid\nflowchart TD\n  Client --> Server\n```";
      const timestamp = yield* nowIso;

      emit({
        id: "evt-copilot-turn-start",
        timestamp,
        parentId: null,
        type: "assistant.turn_start",
        data: {
          turnId: "sdk-turn-1",
        },
      } as SessionEvent);
      emit({
        id: "evt-copilot-task-start",
        timestamp,
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
        timestamp,
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
        id: "evt-copilot-empty-task-start",
        timestamp,
        parentId: null,
        type: "tool.execution_start",
        data: {
          toolCallId: "tool-task-complete-empty-success",
          toolName: "Task_complete",
          arguments: {},
        },
      } as SessionEvent);
      emit({
        id: "evt-copilot-empty-task-complete",
        timestamp,
        parentId: null,
        type: "tool.execution_complete",
        data: {
          toolCallId: "tool-task-complete-empty-success",
          success: true,
          result: {},
        },
      } as SessionEvent);
      emit({
        id: "evt-copilot-failed-task-start",
        timestamp,
        parentId: null,
        type: "tool.execution_start",
        data: {
          toolCallId: "tool-task-complete-failure",
          toolName: "Task_complete",
          arguments: {},
        },
      } as SessionEvent);
      emit({
        id: "evt-copilot-failed-task-complete",
        timestamp,
        parentId: null,
        type: "tool.execution_complete",
        data: {
          toolCallId: "tool-task-complete-failure",
          success: false,
          error: {
            message: "Task completion failed",
          },
        },
      } as SessionEvent);
      emit({
        id: "evt-copilot-idle",
        timestamp,
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
      NodeAssert.ok(turnSnapshot);
      const assistantItem = turnSnapshot.items.find(
        (item) =>
          typeof item === "object" &&
          item !== null &&
          "type" in item &&
          item.type === "assistant_message",
      );
      NodeAssert.deepStrictEqual(assistantItem, {
        type: "assistant_message",
        messageId: `copilot-task-completion-${String(turn.turnId)}`,
        content: resultText,
      });
      NodeAssert.equal(
        turnSnapshot.items.some(
          (item) =>
            typeof item === "object" &&
            item !== null &&
            "type" in item &&
            item.type === "tool_execution",
        ),
        false,
      );

      yield* waitForSdkEventQueue();
      yield* Fiber.interrupt(runtimeEventsFiber).pipe(Effect.ignore);

      const fallbackDelta = runtimeEvents.find(
        (event) => event.type === "content.delta" && event.payload.streamKind === "assistant_text",
      );
      NodeAssert.equal(fallbackDelta?.type, "content.delta");
      if (fallbackDelta?.type === "content.delta") {
        NodeAssert.equal(
          String(fallbackDelta.itemId),
          `copilot-task-completion-${String(turn.turnId)}`,
        );
        NodeAssert.deepStrictEqual(fallbackDelta.payload, {
          streamKind: "assistant_text",
          delta: resultText,
        });
      }
      const taskCompleteToolIds = new Set([
        "copilot-tool-tool-task-complete",
        "copilot-tool-tool-task-complete-empty-success",
        "copilot-tool-tool-task-complete-failure",
      ]);
      NodeAssert.equal(
        runtimeEvents.some(
          (event) =>
            (event.type === "item.started" || event.type === "item.completed") &&
            taskCompleteToolIds.has(String(event.itemId)),
        ),
        false,
      );
      NodeAssert.equal(
        runtimeEvents.some((event) => event.type === "turn.diff.updated"),
        false,
      );

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("emits user interrupt aborts from the SDK abort event", () =>
    Effect.gen(function* () {
      const adapter = yield* CopilotAdapter;
      const threadId = asThreadId("copilot-interrupt-sdk-abort-source");

      yield* adapter.startSession({
        provider: COPILOT_DRIVER,
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });

      const turn = yield* adapter.sendTurn({
        threadId,
        input: "stop this turn",
        attachments: [],
      });

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) => Effect.sync(() => runtimeEvents.push(event))),
        Effect.forkChild,
      );
      yield* waitForSdkEventQueue();

      yield* adapter.interruptTurn(threadId, turn.turnId);
      NodeAssert.equal(runtimeMock.state.lastSession.abort.mock.calls.length, 1);
      yield* waitForSdkEventQueue();
      NodeAssert.equal(runtimeEvents.filter((event) => event.type === "turn.aborted").length, 0);

      const config = runtimeMock.state.createSessionConfigs.at(-1);
      NodeAssert.ok(config?.onEvent);
      const timestamp = yield* nowIso;
      config.onEvent({
        id: "evt-copilot-abort",
        timestamp,
        parentId: null,
        type: "abort",
        data: {
          reason: "user_initiated",
        },
      } as SessionEvent);
      yield* waitForSdkEventQueue();
      yield* Fiber.interrupt(runtimeEventsFiber).pipe(Effect.ignore);

      const abortedEvents = runtimeEvents.filter((event) => event.type === "turn.aborted");
      NodeAssert.equal(abortedEvents.length, 1);
      const aborted = abortedEvents[0];
      NodeAssert.equal(aborted?.type, "turn.aborted");
      if (aborted?.type === "turn.aborted") {
        NodeAssert.equal(String(aborted.turnId), String(turn.turnId));
        NodeAssert.equal(aborted.payload.reason, "user_initiated");
      }

      const completed = runtimeEvents.find((event) => event.type === "turn.completed");
      NodeAssert.equal(completed?.type, "turn.completed");
      if (completed?.type === "turn.completed") {
        NodeAssert.equal(completed.payload.state, "cancelled");
      }

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("does not render the file-change completion fallback as assistant text", () =>
    Effect.gen(function* () {
      const adapter = yield* CopilotAdapter;
      const threadId = asThreadId("copilot-file-change-fallback-filter");

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

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) => Effect.sync(() => runtimeEvents.push(event))),
        Effect.forkChild,
      );
      yield* waitForSdkEventQueue();

      const config = runtimeMock.state.createSessionConfigs.at(-1);
      NodeAssert.ok(config?.onEvent);
      const emit = (event: SessionEvent) => config.onEvent?.(event);
      const timestamp = yield* nowIso;

      emit({
        id: "evt-copilot-file-change-turn-start",
        timestamp,
        parentId: null,
        type: "assistant.turn_start",
        data: {
          turnId: "sdk-turn-file-change",
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
        id: "evt-copilot-file-change-turn-end",
        timestamp,
        parentId: null,
        type: "assistant.turn_end",
        data: {
          turnId: "sdk-turn-file-change",
        },
      } as SessionEvent);

      for (
        let attempt = 0;
        attempt < 20 &&
        !runtimeEvents.some(
          (event) =>
            event.type === "turn.completed" && String(event.turnId) === String(turn.turnId),
        );
        attempt += 1
      ) {
        yield* waitForSdkEventQueue();
      }
      yield* Fiber.interrupt(runtimeEventsFiber).pipe(Effect.ignore);

      const thread = yield* adapter.readThread(threadId);
      const turnSnapshot = thread.turns.find((entry) => entry.id === turn.turnId);
      NodeAssert.ok(turnSnapshot);
      const assistantItems = turnSnapshot.items.filter(
        (item) =>
          typeof item === "object" &&
          item !== null &&
          "type" in item &&
          item.type === "assistant_message",
      );
      NodeAssert.deepStrictEqual(assistantItems, []);
      NodeAssert.equal(
        runtimeEvents.some(
          (event) =>
            event.type === "content.delta" && event.payload.streamKind === "assistant_text",
        ),
        false,
      );

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("does not render the generic tool completion fallback as assistant text", () =>
    Effect.gen(function* () {
      const adapter = yield* CopilotAdapter;
      const threadId = asThreadId("copilot-generic-tool-fallback-filter");

      yield* adapter.startSession({
        provider: COPILOT_DRIVER,
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });

      const turn = yield* adapter.sendTurn({
        threadId,
        input: "inspect the README",
        attachments: [],
      });

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) => Effect.sync(() => runtimeEvents.push(event))),
        Effect.forkChild,
      );
      yield* waitForSdkEventQueue();

      const config = runtimeMock.state.createSessionConfigs.at(-1);
      NodeAssert.ok(config?.onEvent);
      const emit = (event: SessionEvent) => config.onEvent?.(event);
      const timestamp = yield* nowIso;

      emit({
        id: "evt-copilot-generic-tool-turn-start",
        timestamp,
        parentId: null,
        type: "assistant.turn_start",
        data: {
          turnId: "sdk-turn-generic-tool",
        },
      } as SessionEvent);
      emit({
        id: "evt-copilot-generic-tool-start",
        timestamp,
        parentId: null,
        type: "tool.execution_start",
        data: {
          toolCallId: "tool-read-file",
          toolName: "Read",
          arguments: {
            kind: "execute",
            path: "README.md",
          },
        },
      } as SessionEvent);
      emit({
        id: "evt-copilot-generic-tool-complete",
        timestamp,
        parentId: null,
        type: "tool.execution_complete",
        data: {
          toolCallId: "tool-read-file",
          success: true,
          result: {
            content: "# Project",
          },
        },
      } as SessionEvent);
      emit({
        id: "evt-copilot-generic-tool-turn-end",
        timestamp,
        parentId: null,
        type: "assistant.turn_end",
        data: {
          turnId: "sdk-turn-generic-tool",
        },
      } as SessionEvent);

      for (
        let attempt = 0;
        attempt < 20 &&
        !runtimeEvents.some(
          (event) =>
            event.type === "turn.completed" && String(event.turnId) === String(turn.turnId),
        );
        attempt += 1
      ) {
        yield* waitForSdkEventQueue();
      }
      yield* Fiber.interrupt(runtimeEventsFiber).pipe(Effect.ignore);

      const thread = yield* adapter.readThread(threadId);
      const turnSnapshot = thread.turns.find((entry) => entry.id === turn.turnId);
      NodeAssert.ok(turnSnapshot);
      const assistantItems = turnSnapshot.items.filter(
        (item) =>
          typeof item === "object" &&
          item !== null &&
          "type" in item &&
          item.type === "assistant_message",
      );
      NodeAssert.deepStrictEqual(assistantItems, []);
      NodeAssert.equal(
        runtimeEvents.some(
          (event) =>
            event.type === "content.delta" && event.payload.streamKind === "assistant_text",
        ),
        false,
      );

      const startedTool = runtimeEvents.find(
        (event) =>
          event.type === "item.started" && String(event.itemId) === "copilot-tool-tool-read-file",
      );
      NodeAssert.equal(startedTool?.type, "item.started");
      if (startedTool?.type === "item.started") {
        NodeAssert.ok(
          startedTool.payload.data !== null &&
            typeof startedTool.payload.data === "object" &&
            !Array.isArray(startedTool.payload.data),
        );
        const data = startedTool.payload.data as Record<string, unknown>;
        NodeAssert.equal(data.kind, "read");
      }

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("does not render the command-only completion fallback as assistant text", () =>
    Effect.gen(function* () {
      const adapter = yield* CopilotAdapter;
      const threadId = asThreadId("copilot-command-only-fallback-filter");

      yield* adapter.startSession({
        provider: COPILOT_DRIVER,
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });

      const turn = yield* adapter.sendTurn({
        threadId,
        input: "run the tests",
        attachments: [],
      });

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) => Effect.sync(() => runtimeEvents.push(event))),
        Effect.forkChild,
      );
      yield* waitForSdkEventQueue();

      const config = runtimeMock.state.createSessionConfigs.at(-1);
      NodeAssert.ok(config?.onEvent);
      const emit = (event: SessionEvent) => config.onEvent?.(event);
      const timestamp = yield* nowIso;

      emit({
        id: "evt-copilot-command-only-turn-start",
        timestamp,
        parentId: null,
        type: "assistant.turn_start",
        data: {
          turnId: "sdk-turn-command-only",
        },
      } as SessionEvent);
      emit({
        id: "evt-copilot-command-start",
        timestamp,
        parentId: null,
        type: "tool.execution_start",
        data: {
          toolCallId: "tool-run-tests",
          toolName: "bash",
          arguments: {
            command: "vp test",
          },
        },
      } as SessionEvent);
      emit({
        id: "evt-copilot-command-complete",
        timestamp,
        parentId: null,
        type: "tool.execution_complete",
        data: {
          toolCallId: "tool-run-tests",
          success: true,
          result: {
            content: "All tests passed.",
          },
        },
      } as SessionEvent);
      emit({
        id: "evt-copilot-command-only-turn-end",
        timestamp,
        parentId: null,
        type: "assistant.turn_end",
        data: {
          turnId: "sdk-turn-command-only",
        },
      } as SessionEvent);

      for (
        let attempt = 0;
        attempt < 20 &&
        !runtimeEvents.some(
          (event) =>
            event.type === "turn.completed" && String(event.turnId) === String(turn.turnId),
        );
        attempt += 1
      ) {
        yield* waitForSdkEventQueue();
      }
      yield* Fiber.interrupt(runtimeEventsFiber).pipe(Effect.ignore);

      const thread = yield* adapter.readThread(threadId);
      const turnSnapshot = thread.turns.find((entry) => entry.id === turn.turnId);
      NodeAssert.ok(turnSnapshot);
      const assistantItems = turnSnapshot.items.filter(
        (item) =>
          typeof item === "object" &&
          item !== null &&
          "type" in item &&
          item.type === "assistant_message",
      );
      NodeAssert.deepStrictEqual(assistantItems, []);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("does not render the generic completion fallback after a task-completed result", () =>
    Effect.gen(function* () {
      const adapter = yield* CopilotAdapter;
      const threadId = asThreadId("copilot-generic-fallback-task-completed-filter");

      yield* adapter.startSession({
        provider: COPILOT_DRIVER,
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });

      const turn = yield* adapter.sendTurn({
        threadId,
        input: "delegate this task",
        attachments: [],
      });

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) => Effect.sync(() => runtimeEvents.push(event))),
        Effect.forkChild,
      );
      yield* waitForSdkEventQueue();

      const config = runtimeMock.state.createSessionConfigs.at(-1);
      NodeAssert.ok(config?.onEvent);
      const emit = (event: SessionEvent) => config.onEvent?.(event);
      const timestamp = yield* nowIso;

      emit({
        id: "evt-copilot-generic-task-completed-turn-start",
        timestamp,
        parentId: null,
        type: "assistant.turn_start",
        data: {
          turnId: "sdk-turn-generic-task-completed",
        },
      } as SessionEvent);
      emit({
        id: "evt-copilot-generic-task-completed-start",
        timestamp,
        parentId: null,
        type: "tool.execution_start",
        data: {
          toolCallId: "tool-finish-work",
          toolName: "finish_work",
          arguments: {
            description: "finish the work",
          },
        },
      } as SessionEvent);
      emit({
        id: "evt-copilot-generic-task-completed-complete",
        timestamp,
        parentId: null,
        type: "tool.execution_complete",
        data: {
          toolCallId: "tool-finish-work",
          success: true,
          result: {
            content: "✓ Task completed: Updated the implementation.",
          },
        },
      } as SessionEvent);
      emit({
        id: "evt-copilot-generic-task-completed-turn-end",
        timestamp,
        parentId: null,
        type: "assistant.turn_end",
        data: {
          turnId: "sdk-turn-generic-task-completed",
        },
      } as SessionEvent);

      for (
        let attempt = 0;
        attempt < 20 &&
        !runtimeEvents.some(
          (event) =>
            event.type === "turn.completed" && String(event.turnId) === String(turn.turnId),
        );
        attempt += 1
      ) {
        yield* waitForSdkEventQueue();
      }
      yield* Fiber.interrupt(runtimeEventsFiber).pipe(Effect.ignore);

      NodeAssert.ok(
        runtimeEvents.some(
          (event) =>
            event.type === "item.completed" &&
            event.payload.itemType === "dynamic_tool_call" &&
            event.payload.detail === "✓ Task completed: Updated the implementation.",
        ),
      );

      const thread = yield* adapter.readThread(threadId);
      const turnSnapshot = thread.turns.find((entry) => entry.id === turn.turnId);
      NodeAssert.ok(turnSnapshot);
      const assistantItems = turnSnapshot.items.filter(
        (item) =>
          typeof item === "object" &&
          item !== null &&
          "type" in item &&
          item.type === "assistant_message",
      );
      NodeAssert.deepStrictEqual(assistantItems, []);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("does not emit an empty turn diff when a Copilot file-change turn completes", () =>
    Effect.gen(function* () {
      const adapter = yield* CopilotAdapter;
      const threadId = asThreadId("copilot-file-change-turn-diff");

      yield* adapter.startSession({
        provider: COPILOT_DRIVER,
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });

      yield* adapter.sendTurn({
        threadId,
        input: "edit the docs",
        attachments: [],
      });

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) => Effect.sync(() => runtimeEvents.push(event))),
        Effect.forkChild,
      );
      yield* waitForSdkEventQueue();

      const config = runtimeMock.state.createSessionConfigs.at(-1);
      NodeAssert.ok(config?.onEvent);
      const emit = (event: SessionEvent) => config.onEvent?.(event);
      const timestamp = yield* nowIso;

      emit({
        id: "evt-copilot-diff-turn-start",
        timestamp,
        parentId: null,
        type: "assistant.turn_start",
        data: {
          turnId: "sdk-turn-diff",
        },
      } as SessionEvent);
      emit({
        id: "evt-copilot-diff-edit-start",
        timestamp,
        parentId: null,
        type: "tool.execution_start",
        data: {
          toolCallId: "tool-edit-file-diff",
          toolName: "edit_file",
          arguments: {
            path: "README.md",
          },
        },
      } as SessionEvent);
      emit({
        id: "evt-copilot-diff-edit-complete",
        timestamp,
        parentId: null,
        type: "tool.execution_complete",
        data: {
          toolCallId: "tool-edit-file-diff",
          success: true,
          result: {},
        },
      } as SessionEvent);
      emit({
        id: "evt-copilot-diff-turn-end",
        timestamp,
        parentId: null,
        type: "assistant.turn_end",
        data: {
          turnId: "sdk-turn-diff",
        },
      } as SessionEvent);

      yield* waitForSdkEventQueue();
      yield* Fiber.interrupt(runtimeEventsFiber).pipe(Effect.ignore);

      NodeAssert.equal(
        runtimeEvents.some((event) => event.type === "turn.diff.updated"),
        false,
      );

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("emits an active turn diff when a Copilot Apply_patch tool completes", () =>
    Effect.gen(function* () {
      const adapter = yield* CopilotAdapter;
      const threadId = asThreadId("copilot-apply-patch-turn-diff");

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

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) => Effect.sync(() => runtimeEvents.push(event))),
        Effect.forkChild,
      );
      yield* waitForSdkEventQueue();

      const config = runtimeMock.state.createSessionConfigs.at(-1);
      NodeAssert.ok(config?.onEvent);
      const emit = (event: SessionEvent) => config.onEvent?.(event);
      const timestamp = yield* nowIso;
      const patch = "*** Begin Patch\n*** Update File: README.md\n@@\n-old\n+new\n*** End Patch";

      emit({
        id: "evt-copilot-apply-patch-turn-start",
        timestamp,
        parentId: null,
        type: "assistant.turn_start",
        data: {
          turnId: "sdk-turn-apply-patch",
        },
      } as SessionEvent);
      emit({
        id: "evt-copilot-apply-patch-start",
        timestamp,
        parentId: null,
        type: "tool.execution_start",
        data: {
          toolCallId: "tool-apply-patch",
          toolName: "Apply_patch",
          arguments: {
            patch,
          },
        },
      } as SessionEvent);
      emit({
        id: "evt-copilot-apply-patch-complete",
        timestamp,
        parentId: null,
        type: "tool.execution_complete",
        data: {
          toolCallId: "tool-apply-patch",
          success: true,
          result: {
            content: patch,
          },
        },
      } as SessionEvent);
      emit({
        id: "evt-copilot-apply-patch-turn-end",
        timestamp,
        parentId: null,
        type: "assistant.turn_end",
        data: {
          turnId: "sdk-turn-apply-patch",
        },
      } as SessionEvent);

      let diffEvent: ProviderRuntimeEvent | undefined;
      for (let attempt = 0; attempt < 20 && diffEvent === undefined; attempt += 1) {
        yield* waitForSdkEventQueue();
        diffEvent = runtimeEvents.find((event) => event.type === "turn.diff.updated");
      }
      yield* Fiber.interrupt(runtimeEventsFiber).pipe(Effect.ignore);

      NodeAssert.equal(diffEvent?.type, "turn.diff.updated");
      if (diffEvent?.type === "turn.diff.updated") {
        NodeAssert.equal(diffEvent.turnId, turn.turnId);
        NodeAssert.deepStrictEqual(diffEvent.payload, {
          unifiedDiff: patch,
        });
      }

      const completedTool = runtimeEvents.find(
        (event) =>
          event.type === "item.completed" &&
          event.payload.itemType === "file_change" &&
          String(event.itemId) === "copilot-tool-tool-apply-patch",
      );
      NodeAssert.equal(completedTool?.type, "item.completed");

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("classifies terminal apply_patch tool calls as file changes", () =>
    Effect.gen(function* () {
      const adapter = yield* CopilotAdapter;
      const threadId = asThreadId("copilot-terminal-apply-patch-file-change");

      yield* adapter.startSession({
        provider: COPILOT_DRIVER,
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });

      const turn = yield* adapter.sendTurn({
        threadId,
        input: "edit the docs through terminal apply_patch",
        attachments: [],
      });

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) => Effect.sync(() => runtimeEvents.push(event))),
        Effect.forkChild,
      );
      yield* waitForSdkEventQueue();

      const config = runtimeMock.state.createSessionConfigs.at(-1);
      NodeAssert.ok(config?.onEvent);
      const emit = (event: SessionEvent) => config.onEvent?.(event);
      const timestamp = yield* nowIso;
      const patch = "*** Begin Patch\n*** Update File: README.md\n@@\n-old\n+new\n*** End Patch";

      emit({
        id: "evt-copilot-terminal-patch-turn-start",
        timestamp,
        parentId: null,
        type: "assistant.turn_start",
        data: {
          turnId: "sdk-turn-terminal-patch",
        },
      } as SessionEvent);
      emit({
        id: "evt-copilot-terminal-patch-start",
        timestamp,
        parentId: null,
        type: "tool.execution_start",
        data: {
          toolCallId: "tool-terminal-patch",
          toolName: "run_in_terminal",
          arguments: {
            command: `apply_patch <<'PATCH'\n${patch}\nPATCH`,
            kind: "execute",
          },
        },
      } as SessionEvent);
      emit({
        id: "evt-copilot-terminal-patch-complete",
        timestamp,
        parentId: null,
        type: "tool.execution_complete",
        data: {
          toolCallId: "tool-terminal-patch",
          success: true,
          result: {
            content: `${patch}\n<shellId: 9 completed with exit code 0>`,
          },
        },
      } as SessionEvent);

      let diffEvent: ProviderRuntimeEvent | undefined;
      for (let attempt = 0; attempt < 20 && diffEvent === undefined; attempt += 1) {
        yield* waitForSdkEventQueue();
        diffEvent = runtimeEvents.find((event) => event.type === "turn.diff.updated");
      }
      yield* Fiber.interrupt(runtimeEventsFiber).pipe(Effect.ignore);

      const startedTool = runtimeEvents.find(
        (event) =>
          event.type === "item.started" &&
          String(event.itemId) === "copilot-tool-tool-terminal-patch",
      );
      const completedTool = runtimeEvents.find(
        (event) =>
          event.type === "item.completed" &&
          String(event.itemId) === "copilot-tool-tool-terminal-patch",
      );

      NodeAssert.equal(startedTool?.type, "item.started");
      if (startedTool?.type === "item.started") {
        NodeAssert.equal(startedTool.payload.itemType, "file_change");
        NodeAssert.equal(startedTool.payload.title, "Applied patch");
        NodeAssert.ok(
          startedTool.payload.data !== null &&
            typeof startedTool.payload.data === "object" &&
            !Array.isArray(startedTool.payload.data),
        );
        NodeAssert.equal("command" in startedTool.payload.data, false);
        const data = startedTool.payload.data as Record<string, unknown>;
        NodeAssert.equal(data.kind, "edit");
      }
      NodeAssert.equal(completedTool?.type, "item.completed");
      if (completedTool?.type === "item.completed") {
        NodeAssert.equal(completedTool.payload.itemType, "file_change");
        NodeAssert.equal(completedTool.payload.title, "Applied patch");
        NodeAssert.ok(
          completedTool.payload.data !== null &&
            typeof completedTool.payload.data === "object" &&
            !Array.isArray(completedTool.payload.data),
        );
        NodeAssert.equal("command" in completedTool.payload.data, false);
        const data = completedTool.payload.data as Record<string, unknown>;
        NodeAssert.equal(data.kind, "edit");
      }
      NodeAssert.equal(diffEvent?.type, "turn.diff.updated");
      if (diffEvent?.type === "turn.diff.updated") {
        NodeAssert.equal(diffEvent.turnId, turn.turnId);
        NodeAssert.equal(diffEvent.payload.unifiedDiff, patch);
      }

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("emits turn diffs when apply-patch output is only in the command", () =>
    Effect.gen(function* () {
      const adapter = yield* CopilotAdapter;
      const threadId = asThreadId("copilot-terminal-patch-command-only");

      yield* adapter.startSession({
        provider: COPILOT_DRIVER,
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      const turn = yield* adapter.sendTurn({
        threadId,
        input: "apply a patch",
        attachments: [],
      });

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) => Effect.sync(() => runtimeEvents.push(event))),
        Effect.forkChild,
      );
      yield* waitForSdkEventQueue();

      const config = runtimeMock.state.createSessionConfigs.at(-1);
      NodeAssert.ok(config?.onEvent);
      const emit = (event: SessionEvent) => config.onEvent?.(event);
      const timestamp = yield* nowIso;
      const patch = "*** Begin Patch\n*** Update File: README.md\n@@\n-old\n+new\n*** End Patch";

      emit({
        id: "evt-copilot-terminal-patch-command-only-turn-start",
        timestamp,
        parentId: null,
        type: "assistant.turn_start",
        data: { turnId: "sdk-turn-terminal-patch-command-only" },
      } as SessionEvent);
      emit({
        id: "evt-copilot-terminal-patch-command-only-start",
        timestamp,
        parentId: null,
        type: "tool.execution_start",
        data: {
          toolCallId: "tool-terminal-patch-command-only",
          toolName: "run_in_terminal",
          arguments: {
            command: `apply_patch <<'PATCH'\n${patch}\nPATCH`,
          },
        },
      } as SessionEvent);
      emit({
        id: "evt-copilot-terminal-patch-command-only-complete",
        timestamp,
        parentId: null,
        type: "tool.execution_complete",
        data: {
          toolCallId: "tool-terminal-patch-command-only",
          success: true,
          result: { content: "" },
        },
      } as SessionEvent);

      let diffEvent: ProviderRuntimeEvent | undefined;
      for (let attempt = 0; attempt < 20 && diffEvent === undefined; attempt += 1) {
        yield* waitForSdkEventQueue();
        diffEvent = runtimeEvents.find((event) => event.type === "turn.diff.updated");
      }
      yield* Fiber.interrupt(runtimeEventsFiber).pipe(Effect.ignore);

      NodeAssert.equal(diffEvent?.type, "turn.diff.updated");
      if (diffEvent?.type === "turn.diff.updated") {
        NodeAssert.equal(diffEvent.turnId, turn.turnId);
        NodeAssert.equal(diffEvent.payload.unifiedDiff, patch);
      }

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect(
    "does not emit an active turn diff when a Copilot command tool returns shell control output",
    () =>
      Effect.gen(function* () {
        const adapter = yield* CopilotAdapter;
        const threadId = asThreadId("copilot-command-turn-diff");
        const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

        try {
          yield* adapter.startSession({
            provider: COPILOT_DRIVER,
            threadId,
            cwd: process.cwd(),
            runtimeMode: "approval-required",
          });

          yield* adapter.sendTurn({
            threadId,
            input: "run a command",
            attachments: [],
          });

          const runtimeEvents: ProviderRuntimeEvent[] = [];
          const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
            Stream.runForEach((event) => Effect.sync(() => runtimeEvents.push(event))),
            Effect.forkChild,
          );
          yield* waitForSdkEventQueue();

          const config = runtimeMock.state.createSessionConfigs.at(-1);
          NodeAssert.ok(config?.onEvent);
          const emit = (event: SessionEvent) => config.onEvent?.(event);
          const timestamp = yield* nowIso;

          emit({
            id: "evt-copilot-command-turn-start",
            timestamp,
            parentId: null,
            type: "assistant.turn_start",
            data: {
              turnId: "sdk-turn-command",
            },
          } as SessionEvent);
          emit({
            id: "evt-copilot-command-start",
            timestamp,
            parentId: null,
            type: "tool.execution_start",
            data: {
              toolCallId: "tool-command",
              toolName: "bash",
              arguments: {
                command: "printf done > README.md",
              },
            },
          } as SessionEvent);
          emit({
            id: "evt-copilot-command-complete",
            timestamp,
            parentId: null,
            type: "tool.execution_complete",
            data: {
              toolCallId: "tool-command",
              success: true,
              result: {
                content: "<shellId: 4 completed with exit code 0>",
              },
            },
          } as SessionEvent);
          emit({
            id: "evt-copilot-command-turn-end",
            timestamp,
            parentId: null,
            type: "assistant.turn_end",
            data: {
              turnId: "sdk-turn-command",
            },
          } as SessionEvent);

          yield* waitForSdkEventQueue();
          yield* Fiber.interrupt(runtimeEventsFiber).pipe(Effect.ignore);

          NodeAssert.equal(
            runtimeEvents.some((event) => event.type === "turn.diff.updated"),
            false,
          );

          const parserErrorCalls = [
            ...consoleErrorSpy.mock.calls,
            ...consoleLogSpy.mock.calls,
          ].filter((args) => args.some((arg: unknown) => String(arg).includes("parseLineType")));
          NodeAssert.deepStrictEqual(parserErrorCalls, []);

          const completedTool = runtimeEvents.find(
            (event) =>
              event.type === "item.completed" &&
              event.payload.itemType === "command_execution" &&
              String(event.itemId) === "copilot-tool-tool-command",
          );
          NodeAssert.equal(completedTool?.type, "item.completed");

          yield* adapter.stopSession(threadId);
        } finally {
          consoleErrorSpy.mockRestore();
          consoleLogSpy.mockRestore();
        }
      }),
  );

  it.effect(
    "emits an active turn diff when a Copilot command tool returns git unified diff output",
    () =>
      Effect.gen(function* () {
        const adapter = yield* CopilotAdapter;
        const threadId = asThreadId("copilot-command-unified-diff-turn");

        yield* adapter.startSession({
          provider: COPILOT_DRIVER,
          threadId,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
        });

        const turn = yield* adapter.sendTurn({
          threadId,
          input: "run a command",
          attachments: [],
        });

        const runtimeEvents: ProviderRuntimeEvent[] = [];
        const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
          Stream.runForEach((event) => Effect.sync(() => runtimeEvents.push(event))),
          Effect.forkChild,
        );
        yield* waitForSdkEventQueue();

        const config = runtimeMock.state.createSessionConfigs.at(-1);
        NodeAssert.ok(config?.onEvent);
        const emit = (event: SessionEvent) => config.onEvent?.(event);
        const timestamp = yield* nowIso;
        const diff = [
          "diff --git a/README.md b/README.md",
          "index 1111111..2222222 100644",
          "--- a/README.md",
          "+++ b/README.md",
          "@@ -1 +1 @@",
          "-old",
          "+new",
          "",
        ].join("\n");

        emit({
          id: "evt-copilot-command-diff-turn-start",
          timestamp,
          parentId: null,
          type: "assistant.turn_start",
          data: {
            turnId: "sdk-turn-command-diff",
          },
        } as SessionEvent);
        emit({
          id: "evt-copilot-command-diff-start",
          timestamp,
          parentId: null,
          type: "tool.execution_start",
          data: {
            toolCallId: "tool-command-diff",
            toolName: "bash",
            arguments: {
              command: "git diff -- README.md",
            },
          },
        } as SessionEvent);
        emit({
          id: "evt-copilot-command-diff-complete",
          timestamp,
          parentId: null,
          type: "tool.execution_complete",
          data: {
            toolCallId: "tool-command-diff",
            success: true,
            result: {
              content: diff,
            },
          },
        } as SessionEvent);
        emit({
          id: "evt-copilot-command-diff-turn-end",
          timestamp,
          parentId: null,
          type: "assistant.turn_end",
          data: {
            turnId: "sdk-turn-command-diff",
          },
        } as SessionEvent);

        let diffEvent: ProviderRuntimeEvent | undefined;
        for (let attempt = 0; attempt < 20 && diffEvent === undefined; attempt += 1) {
          yield* waitForSdkEventQueue();
          diffEvent = runtimeEvents.find((event) => event.type === "turn.diff.updated");
        }
        yield* Fiber.interrupt(runtimeEventsFiber).pipe(Effect.ignore);

        NodeAssert.equal(diffEvent?.type, "turn.diff.updated");
        if (diffEvent?.type === "turn.diff.updated") {
          NodeAssert.equal(diffEvent.turnId, turn.turnId);
          NodeAssert.deepStrictEqual(diffEvent.payload, {
            unifiedDiff: diff.trim(),
          });
        }

        yield* adapter.stopSession(threadId);
      }),
  );

  it.effect("emits turn diff when a Copilot write permission is approved", () =>
    Effect.gen(function* () {
      const adapter = yield* CopilotAdapter;
      const threadId = asThreadId("copilot-write-permission-turn-diff");

      yield* adapter.startSession({
        provider: COPILOT_DRIVER,
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });

      const turn = yield* adapter.sendTurn({
        threadId,
        input: "update the README",
        attachments: [],
      });

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) => Effect.sync(() => runtimeEvents.push(event))),
        Effect.forkChild,
      );
      yield* waitForSdkEventQueue();

      const config = runtimeMock.state.createSessionConfigs.at(-1);
      NodeAssert.ok(config?.onEvent);
      NodeAssert.ok(config.onPermissionRequest);
      const emit = (event: SessionEvent) => config.onEvent?.(event);
      const timestamp = yield* nowIso;
      const requestId = "permission-write-readme";
      const permissionRequest = {
        kind: "write",
        toolCallId: "tool-write-readme",
        fileName: "README.md",
        diff: "--- a/README.md\n+++ b/README.md\n@@\n-old\n+new\n",
        intention: "Update README",
        canOfferSessionApproval: true,
      } as Extract<PermissionRequest, { kind: "write" }>;

      emit({
        id: "evt-copilot-write-permission-turn-start",
        timestamp,
        parentId: null,
        type: "assistant.turn_start",
        data: {
          turnId: "sdk-turn-write-permission",
        },
      } as SessionEvent);

      const resultPromise = Promise.resolve(
        config.onPermissionRequest(permissionRequest, {
          sessionId: runtimeMock.state.lastSession.sessionId,
        }),
      );
      emit({
        id: "evt-copilot-write-permission-requested",
        timestamp,
        parentId: null,
        type: "permission.requested",
        data: {
          requestId,
          permissionRequest,
          promptRequest: undefined,
        },
      } as unknown as SessionEvent);

      let opened: ProviderRuntimeEvent | undefined;
      for (let attempt = 0; attempt < 20 && opened === undefined; attempt += 1) {
        yield* waitForSdkEventQueue();
        opened = runtimeEvents.find(
          (event) => event.type === "request.opened" && String(event.requestId) === requestId,
        );
      }
      NodeAssert.equal(opened?.type, "request.opened");
      if (opened?.type === "request.opened") {
        NodeAssert.equal(opened.payload.requestType, "file_change_approval");
        NodeAssert.equal(String(opened.turnId), String(turn.turnId));
      }

      yield* adapter.respondToRequest(threadId, ApprovalRequestId.make(requestId), "accept");
      const approvalResult = yield* Effect.promise(() => resultPromise);
      NodeAssert.deepStrictEqual(approvalResult, { kind: "approve-once" });

      emit({
        id: "evt-copilot-write-permission-completed",
        timestamp,
        parentId: null,
        type: "permission.completed",
        data: {
          requestId,
          result: approvalResult,
        },
      } as SessionEvent);
      emit({
        id: "evt-copilot-write-permission-turn-end",
        timestamp,
        parentId: null,
        type: "assistant.turn_end",
        data: {
          turnId: "sdk-turn-write-permission",
        },
      } as SessionEvent);

      yield* waitForSdkEventQueue();
      yield* Fiber.interrupt(runtimeEventsFiber).pipe(Effect.ignore);

      const diffUpdated = runtimeEvents.find((event) => event.type === "turn.diff.updated");
      NodeAssert.equal(diffUpdated?.type, "turn.diff.updated");
      if (diffUpdated?.type === "turn.diff.updated") {
        NodeAssert.equal(String(diffUpdated.turnId), String(turn.turnId));
        NodeAssert.deepStrictEqual(diffUpdated.payload, {
          unifiedDiff: permissionRequest.diff.trim(),
        });
      }

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("emits turn diff when Copilot completes write permission with location approval", () =>
    Effect.gen(function* () {
      const adapter = yield* CopilotAdapter;
      const threadId = asThreadId("copilot-write-permission-location-diff");

      yield* adapter.startSession({
        provider: COPILOT_DRIVER,
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });

      const turn = yield* adapter.sendTurn({
        threadId,
        input: "update the README",
        attachments: [],
      });

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) => Effect.sync(() => runtimeEvents.push(event))),
        Effect.forkChild,
      );
      yield* waitForSdkEventQueue();

      const config = runtimeMock.state.createSessionConfigs.at(-1);
      NodeAssert.ok(config?.onEvent);
      NodeAssert.ok(config.onPermissionRequest);
      const emit = (event: SessionEvent) => config.onEvent?.(event);
      const timestamp = yield* nowIso;
      const requestId = "permission-write-readme-location";
      const permissionRequest = {
        kind: "write",
        toolCallId: "tool-write-readme-location",
        fileName: "README.md",
        diff: "--- a/README.md\n+++ b/README.md\n@@\n-old\n+new\n",
        intention: "Update README",
        canOfferSessionApproval: true,
      } as Extract<PermissionRequest, { kind: "write" }>;

      emit({
        id: "evt-copilot-write-location-turn-start",
        timestamp,
        parentId: null,
        type: "assistant.turn_start",
        data: { turnId: "sdk-turn-write-location" },
      } as SessionEvent);
      void config.onPermissionRequest(permissionRequest, {
        sessionId: runtimeMock.state.lastSession.sessionId,
      });
      emit({
        id: "evt-copilot-write-location-requested",
        timestamp,
        parentId: null,
        type: "permission.requested",
        data: {
          requestId,
          permissionRequest,
          promptRequest: undefined,
        },
      } as unknown as SessionEvent);
      yield* waitForSdkEventQueue();

      emit({
        id: "evt-copilot-write-location-completed",
        timestamp,
        parentId: null,
        type: "permission.completed",
        data: {
          requestId,
          result: { kind: "approve-for-location" },
        },
      } as unknown as SessionEvent);

      let diffUpdated: ProviderRuntimeEvent | undefined;
      for (let attempt = 0; attempt < 20 && diffUpdated === undefined; attempt += 1) {
        yield* waitForSdkEventQueue();
        diffUpdated = runtimeEvents.find((event) => event.type === "turn.diff.updated");
      }
      yield* Fiber.interrupt(runtimeEventsFiber).pipe(Effect.ignore);

      NodeAssert.equal(diffUpdated?.type, "turn.diff.updated");
      if (diffUpdated?.type === "turn.diff.updated") {
        NodeAssert.equal(String(diffUpdated.turnId), String(turn.turnId));
        NodeAssert.deepStrictEqual(diffUpdated.payload, {
          unifiedDiff: permissionRequest.diff.trim(),
        });
      }

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("prompts for shell permissions in auto-accept-edits mode", () =>
    Effect.gen(function* () {
      const adapter = yield* CopilotAdapter;
      const threadId = asThreadId("copilot-auto-accept-edits-shell-permission");

      yield* adapter.startSession({
        provider: COPILOT_DRIVER,
        threadId,
        cwd: process.cwd(),
        runtimeMode: "auto-accept-edits",
      });

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) => Effect.sync(() => runtimeEvents.push(event))),
        Effect.forkChild,
      );
      yield* waitForSdkEventQueue();

      const config = runtimeMock.state.createSessionConfigs.at(-1);
      NodeAssert.ok(config?.onEvent);
      NodeAssert.ok(config.onPermissionRequest);

      const permissionRequest: PermissionRequest = {
        kind: "shell",
        toolCallId: "tool-shell-auto-accept-edits",
        fullCommandText: "git status",
        intention: "Check repository status",
        commands: [{ identifier: "git", readOnly: true }],
        possiblePaths: [],
        possibleUrls: [],
        hasWriteFileRedirection: false,
        canOfferSessionApproval: true,
      };
      const requestId = "permission-shell-auto-accept-edits";
      const resultPromise = Promise.resolve(
        config.onPermissionRequest(permissionRequest, {
          sessionId: runtimeMock.state.lastSession.sessionId,
        }),
      );
      const timestamp = yield* nowIso;

      config.onEvent({
        id: "evt-copilot-permission-auto-accept-edits",
        timestamp,
        parentId: null,
        type: "permission.requested",
        data: {
          requestId,
          permissionRequest,
          promptRequest: {
            kind: "commands",
            toolCallId: "tool-shell-auto-accept-edits",
            fullCommandText: "git status",
            intention: "Check repository status",
            commandIdentifiers: ["git"],
            canOfferSessionApproval: true,
          },
        },
      } as SessionEvent);

      let opened: ProviderRuntimeEvent | undefined;
      for (let attempt = 0; attempt < 20 && opened === undefined; attempt += 1) {
        yield* waitForSdkEventQueue();
        opened = runtimeEvents.find(
          (event) => event.type === "request.opened" && String(event.requestId) === requestId,
        );
      }
      NodeAssert.equal(opened?.type, "request.opened");

      yield* adapter.respondToRequest(threadId, ApprovalRequestId.make(requestId), "accept");
      const result = yield* Effect.promise(() => resultPromise);
      NodeAssert.deepStrictEqual(result, { kind: "approve-once" });

      yield* Fiber.interrupt(runtimeEventsFiber).pipe(Effect.ignore);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("emits thread metadata updates from Copilot title changes", () =>
    Effect.gen(function* () {
      const adapter = yield* CopilotAdapter;
      const threadId = asThreadId("copilot-title-change");

      yield* adapter.startSession({
        provider: COPILOT_DRIVER,
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) => Effect.sync(() => runtimeEvents.push(event))),
        Effect.forkChild,
      );
      yield* waitForSdkEventQueue();

      const config = runtimeMock.state.createSessionConfigs.at(-1);
      NodeAssert.ok(config?.onEvent);
      const timestamp = yield* nowIso;
      config.onEvent({
        id: "evt-copilot-title-change",
        timestamp,
        parentId: null,
        type: "session.title_changed",
        data: {
          title: "Implement Copilot thread titles",
        },
      } as SessionEvent);

      let titleEvent: ProviderRuntimeEvent | undefined;
      for (let attempt = 0; attempt < 20 && titleEvent === undefined; attempt += 1) {
        yield* waitForSdkEventQueue();
        titleEvent = runtimeEvents.find((event) => event.type === "thread.metadata.updated");
      }
      yield* Fiber.interrupt(runtimeEventsFiber).pipe(Effect.ignore);

      NodeAssert.equal(titleEvent?.type, "thread.metadata.updated");
      if (titleEvent?.type === "thread.metadata.updated") {
        NodeAssert.equal(titleEvent.threadId, threadId);
        NodeAssert.deepStrictEqual(titleEvent.payload, {
          name: "Implement Copilot thread titles",
        });
      }

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("emits Copilot background tasks as task list plan updates", () =>
    Effect.gen(function* () {
      const adapter = yield* CopilotAdapter;
      const threadId = asThreadId("copilot-background-tasks-plan");

      yield* adapter.startSession({
        provider: COPILOT_DRIVER,
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });

      const turn = yield* adapter.sendTurn({
        threadId,
        input: "delegate the investigation",
        attachments: [],
      });

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) => Effect.sync(() => runtimeEvents.push(event))),
        Effect.forkChild,
      );
      yield* waitForSdkEventQueue();

      runtimeMock.state.lastSession.rpc.backgroundTasks.list.mockResolvedValueOnce({
        tasks: [
          {
            type: "agent",
            id: "task-explore-1",
            toolCallId: "tool-task-explore-1",
            description: "Exploring provider events",
            status: "running",
            startedAt: "2026-06-11T12:00:00.000Z",
            agentType: "explore",
            prompt: "Find Copilot task events",
          },
          {
            type: "shell",
            id: "task-shell-1",
            description: "Running tests",
            status: "completed",
            startedAt: "2026-06-11T12:00:01.000Z",
            command: "vp test",
            attachmentMode: "detached",
          },
          {
            type: "agent",
            id: "task-review-1",
            toolCallId: "tool-task-review-1",
            description: "Reviewing implementation",
            status: "failed",
            startedAt: "2026-06-11T12:00:02.000Z",
            agentType: "code-review",
            prompt: "Review the implementation",
          },
        ],
      });

      const config = runtimeMock.state.createSessionConfigs.at(-1);
      NodeAssert.ok(config?.onEvent);
      const timestamp = yield* nowIso;
      config.onEvent({
        id: "evt-copilot-background-tasks",
        timestamp,
        parentId: null,
        ephemeral: true,
        type: "session.background_tasks_changed",
        data: {},
      } as SessionEvent);

      let planEvent: ProviderRuntimeEvent | undefined;
      for (let attempt = 0; attempt < 20 && planEvent === undefined; attempt += 1) {
        yield* waitForSdkEventQueue();
        planEvent = runtimeEvents.find((event) => event.type === "turn.plan.updated");
      }
      yield* Fiber.interrupt(runtimeEventsFiber).pipe(Effect.ignore);

      NodeAssert.equal(planEvent?.type, "turn.plan.updated");
      if (planEvent?.type === "turn.plan.updated") {
        NodeAssert.equal(planEvent.threadId, threadId);
        NodeAssert.equal(String(planEvent.turnId), String(turn.turnId));
        NodeAssert.deepStrictEqual(planEvent.payload, {
          explanation: "Copilot Tasks",
          plan: [
            { step: "Exploring provider events", status: "inProgress" },
            { step: "Running tests", status: "completed" },
            { step: "Reviewing implementation (failed)", status: "pending" },
          ],
        });
      }
      const startedTasks = runtimeEvents.filter((event) => event.type === "task.started");
      NodeAssert.deepStrictEqual(startedTasks.map((event) => String(event.payload.taskId)).sort(), [
        "task-explore-1",
        "task-review-1",
        "task-shell-1",
      ]);
      const runningProgress = runtimeEvents.find(
        (event) =>
          event.type === "task.progress" && String(event.payload.taskId) === "task-explore-1",
      );
      NodeAssert.equal(runningProgress?.type, "task.progress");
      if (runningProgress?.type === "task.progress") {
        NodeAssert.equal(runningProgress.payload.description, "Exploring provider events");
        NodeAssert.equal(runningProgress.payload.summary, "Task running");
      }
      const completedTasks = runtimeEvents.filter((event) => event.type === "task.completed");
      NodeAssert.deepStrictEqual(
        completedTasks.map((event) => [String(event.payload.taskId), event.payload.status]).sort(),
        [
          ["task-review-1", "failed"],
          ["task-shell-1", "completed"],
        ],
      );

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("tracks Copilot background task status changes", () =>
    Effect.gen(function* () {
      const adapter = yield* CopilotAdapter;
      const threadId = asThreadId("copilot-background-task-status-changes");

      yield* adapter.startSession({
        provider: COPILOT_DRIVER,
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });

      const turn = yield* adapter.sendTurn({
        threadId,
        input: "delegate the investigation",
        attachments: [],
      });

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) => Effect.sync(() => runtimeEvents.push(event))),
        Effect.forkChild,
      );
      yield* waitForSdkEventQueue();

      const config = runtimeMock.state.createSessionConfigs.at(-1);
      NodeAssert.ok(config?.onEvent);
      const timestamp = yield* nowIso;

      runtimeMock.state.lastSession.rpc.backgroundTasks.list.mockResolvedValueOnce({
        tasks: [
          {
            type: "agent",
            id: "task-status-1",
            toolCallId: "tool-task-status-1",
            description: "Inspect implementation",
            status: "running",
            startedAt: "2026-06-11T12:00:00.000Z",
            agentType: "explore",
            prompt: "Inspect implementation",
          },
        ],
      });
      config.onEvent({
        id: "evt-copilot-background-task-status-running",
        timestamp,
        parentId: null,
        ephemeral: true,
        type: "session.background_tasks_changed",
        data: {},
      } as SessionEvent);

      for (
        let attempt = 0;
        attempt < 20 &&
        !runtimeEvents.some(
          (event) =>
            event.type === "task.progress" && String(event.payload.taskId) === "task-status-1",
        );
        attempt += 1
      ) {
        yield* waitForSdkEventQueue();
      }

      runtimeMock.state.lastSession.rpc.backgroundTasks.list.mockResolvedValueOnce({
        tasks: [
          {
            type: "agent",
            id: "task-status-1",
            toolCallId: "tool-task-status-1",
            description: "Inspect implementation",
            status: "completed",
            startedAt: "2026-06-11T12:00:00.000Z",
            completedAt: "2026-06-11T12:00:03.000Z",
            agentType: "explore",
            prompt: "Inspect implementation",
            result: "Inspection completed",
          },
        ],
      });
      config.onEvent({
        id: "evt-copilot-background-task-status-completed",
        timestamp,
        parentId: null,
        ephemeral: true,
        type: "session.background_tasks_changed",
        data: {},
      } as SessionEvent);

      for (
        let attempt = 0;
        attempt < 20 &&
        !runtimeEvents.some(
          (event) =>
            event.type === "task.completed" && String(event.payload.taskId) === "task-status-1",
        );
        attempt += 1
      ) {
        yield* waitForSdkEventQueue();
      }
      yield* Fiber.interrupt(runtimeEventsFiber).pipe(Effect.ignore);

      const startedEvents = runtimeEvents.filter(
        (event) =>
          event.type === "task.started" && String(event.payload.taskId) === "task-status-1",
      );
      const completedEvent = runtimeEvents.find(
        (event) =>
          event.type === "task.completed" && String(event.payload.taskId) === "task-status-1",
      );
      NodeAssert.equal(startedEvents.length, 1);
      NodeAssert.equal(completedEvent?.type, "task.completed");
      if (completedEvent?.type === "task.completed") {
        NodeAssert.equal(completedEvent.turnId, turn.turnId);
        NodeAssert.equal(completedEvent.payload.status, "completed");
        NodeAssert.equal(completedEvent.payload.summary, "Inspection completed");
      }

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("maps Copilot todo tool input to T3 plan updates", () =>
    Effect.gen(function* () {
      const adapter = yield* CopilotAdapter;
      const threadId = asThreadId("copilot-todo-tool-plan-update");

      yield* adapter.startSession({
        provider: COPILOT_DRIVER,
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });

      const turn = yield* adapter.sendTurn({
        threadId,
        input: "track todos",
        attachments: [],
      });

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) => Effect.sync(() => runtimeEvents.push(event))),
        Effect.forkChild,
      );
      yield* waitForSdkEventQueue();

      const config = runtimeMock.state.createSessionConfigs.at(-1);
      NodeAssert.ok(config?.onEvent);
      const timestamp = yield* nowIso;
      config.onEvent({
        id: "evt-copilot-todo-turn-start",
        timestamp,
        parentId: null,
        type: "assistant.turn_start",
        data: {
          turnId: "sdk-turn-todo-tool",
        },
      } as SessionEvent);
      config.onEvent({
        id: "evt-copilot-todo-tool-start",
        timestamp,
        parentId: null,
        type: "tool.execution_start",
        data: {
          toolCallId: "tool-todo-write",
          toolName: "TodoWrite",
          arguments: {
            todos: [
              { content: "Inspect adapter", status: "completed" },
              { content: "Wire task events", status: "in_progress" },
              { content: "Run validation", status: "pending" },
            ],
          },
          turnId: "sdk-turn-todo-tool",
        },
      } as SessionEvent);

      let planEvent: ProviderRuntimeEvent | undefined;
      for (let attempt = 0; attempt < 20 && planEvent === undefined; attempt += 1) {
        yield* waitForSdkEventQueue();
        planEvent = runtimeEvents.find((event) => event.type === "turn.plan.updated");
      }
      yield* Fiber.interrupt(runtimeEventsFiber).pipe(Effect.ignore);

      NodeAssert.equal(planEvent?.type, "turn.plan.updated");
      if (planEvent?.type === "turn.plan.updated") {
        NodeAssert.equal(String(planEvent.turnId), String(turn.turnId));
        NodeAssert.deepStrictEqual(planEvent.payload, {
          explanation: "Copilot Todos",
          plan: [
            { step: "Inspect adapter", status: "completed" },
            { step: "Wire task events", status: "inProgress" },
            { step: "Run validation", status: "pending" },
          ],
        });
      }

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("ignores empty Copilot background task plan updates", () =>
    Effect.gen(function* () {
      const adapter = yield* CopilotAdapter;
      const threadId = asThreadId("copilot-empty-background-tasks-plan");

      yield* adapter.startSession({
        provider: COPILOT_DRIVER,
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });

      yield* adapter.sendTurn({
        threadId,
        input: "delegate the investigation",
        attachments: [],
      });

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) => Effect.sync(() => runtimeEvents.push(event))),
        Effect.forkChild,
      );
      yield* waitForSdkEventQueue();

      runtimeMock.state.lastSession.rpc.backgroundTasks.list.mockResolvedValueOnce({
        tasks: [],
      });

      const config = runtimeMock.state.createSessionConfigs.at(-1);
      NodeAssert.ok(config?.onEvent);
      const timestamp = yield* nowIso;
      config.onEvent({
        id: "evt-copilot-empty-background-tasks",
        timestamp,
        parentId: null,
        ephemeral: true,
        type: "session.background_tasks_changed",
        data: {},
      } as SessionEvent);
      config.onEvent({
        id: "evt-copilot-empty-background-tasks-drain-marker",
        timestamp,
        parentId: null,
        type: "assistant.turn_start",
        data: {
          turnId: "sdk-turn-after-empty-background-tasks",
        },
      } as SessionEvent);

      let markerEvent: ProviderRuntimeEvent | undefined;
      for (let attempt = 0; attempt < 20 && markerEvent === undefined; attempt += 1) {
        yield* waitForSdkEventQueue();
        markerEvent = runtimeEvents.find(
          (event) =>
            event.type === "session.state.changed" &&
            event.payload.reason === "Copilot turn started",
        );
      }
      yield* Fiber.interrupt(runtimeEventsFiber).pipe(Effect.ignore);

      NodeAssert.equal(markerEvent?.type, "session.state.changed");
      NodeAssert.equal(
        runtimeEvents.find((event) => event.type === "turn.plan.updated"),
        undefined,
      );

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("ignores background task change events when Copilot cannot list tasks", () =>
    Effect.gen(function* () {
      const adapter = yield* CopilotAdapter;
      const threadId = asThreadId("copilot-background-tasks-missing-list");

      yield* adapter.startSession({
        provider: COPILOT_DRIVER,
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });

      yield* adapter.sendTurn({
        threadId,
        input: "delegate the investigation",
        attachments: [],
      });

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) => Effect.sync(() => runtimeEvents.push(event))),
        Effect.forkChild,
      );
      yield* waitForSdkEventQueue();

      const session = runtimeMock.state.lastSession as unknown as {
        rpc: { backgroundTasks?: unknown };
      };
      delete session.rpc.backgroundTasks;

      const config = runtimeMock.state.createSessionConfigs.at(-1);
      NodeAssert.ok(config?.onEvent);
      const timestamp = yield* nowIso;
      config.onEvent({
        id: "evt-copilot-background-tasks-without-list",
        timestamp,
        parentId: null,
        ephemeral: true,
        type: "session.background_tasks_changed",
        data: {},
      } as SessionEvent);
      config.onEvent({
        id: "evt-copilot-background-tasks-drain-marker",
        timestamp,
        parentId: null,
        type: "assistant.turn_start",
        data: {
          turnId: "sdk-turn-after-background-tasks",
        },
      } as SessionEvent);

      let markerEvent: ProviderRuntimeEvent | undefined;
      for (let attempt = 0; attempt < 20 && markerEvent === undefined; attempt += 1) {
        yield* waitForSdkEventQueue();
        markerEvent = runtimeEvents.find(
          (event) =>
            event.type === "session.state.changed" &&
            event.payload.reason === "Copilot turn started",
        );
      }
      yield* Fiber.interrupt(runtimeEventsFiber).pipe(Effect.ignore);

      NodeAssert.equal(markerEvent?.type, "session.state.changed");
      NodeAssert.equal(
        runtimeEvents.find((event) => event.type === "turn.plan.updated"),
        undefined,
      );
      NodeAssert.equal(
        runtimeEvents.find((event) => event.type === "runtime.error"),
        undefined,
      );

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("emits command metadata separately from command output", () =>
    Effect.gen(function* () {
      const adapter = yield* CopilotAdapter;
      const threadId = asThreadId("copilot-command-metadata");

      yield* adapter.startSession({
        provider: COPILOT_DRIVER,
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });

      yield* adapter.sendTurn({
        threadId,
        input: "check git status",
        attachments: [],
      });

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) => Effect.sync(() => runtimeEvents.push(event))),
        Effect.forkChild,
      );
      yield* waitForSdkEventQueue();

      const config = runtimeMock.state.createSessionConfigs.at(-1);
      NodeAssert.ok(config?.onEvent);
      const emit = (event: SessionEvent) => config.onEvent?.(event);
      const timestamp = yield* nowIso;

      emit({
        id: "evt-copilot-command-turn-start",
        timestamp,
        parentId: null,
        type: "assistant.turn_start",
        data: {
          turnId: "sdk-turn-command",
        },
      } as SessionEvent);
      emit({
        id: "evt-copilot-command-start",
        timestamp,
        parentId: null,
        type: "tool.execution_start",
        data: {
          toolCallId: "tool-command",
          toolName: "bash",
          arguments: {
            command: "git status --short",
          },
        },
      } as SessionEvent);
      for (
        let attempt = 0;
        attempt < 20 &&
        !runtimeEvents.some(
          (event) =>
            event.type === "item.started" && String(event.itemId) === "copilot-tool-tool-command",
        );
        attempt += 1
      ) {
        yield* waitForSdkEventQueue();
      }
      emit({
        id: "evt-copilot-command-complete",
        timestamp,
        parentId: null,
        type: "tool.execution_complete",
        data: {
          toolCallId: "tool-command",
          success: true,
          result: {
            content: " M apps/server/src/provider/Layers/CopilotAdapter.ts",
          },
        },
      } as SessionEvent);

      let started: ProviderRuntimeEvent | undefined;
      let completed: ProviderRuntimeEvent | undefined;
      for (let attempt = 0; attempt < 20 && completed === undefined; attempt += 1) {
        yield* waitForSdkEventQueue();
        started ??= runtimeEvents.find(
          (event) =>
            event.type === "item.started" && String(event.itemId) === "copilot-tool-tool-command",
        );
        completed = runtimeEvents.find(
          (event) =>
            event.type === "item.completed" && String(event.itemId) === "copilot-tool-tool-command",
        );
      }
      yield* Fiber.interrupt(runtimeEventsFiber).pipe(Effect.ignore);

      NodeAssert.equal(started?.type, "item.started");
      if (started?.type === "item.started") {
        NodeAssert.equal(started.payload.itemType, "command_execution");
        NodeAssert.equal(started.payload.title, "Ran command: git status --short");
        NodeAssert.equal(started.payload.detail, "git status --short");
      }

      NodeAssert.equal(completed?.type, "item.completed");
      if (completed?.type === "item.completed") {
        NodeAssert.equal(completed.payload.itemType, "command_execution");
        NodeAssert.equal(completed.payload.title, "Ran command: git status --short");
        NodeAssert.equal(
          completed.payload.detail,
          "M apps/server/src/provider/Layers/CopilotAdapter.ts",
        );
        NodeAssert.deepStrictEqual(completed.payload.data, {
          toolCallId: "tool-command",
          toolName: "bash",
          command: "git status --short",
          result: {
            content: " M apps/server/src/provider/Layers/CopilotAdapter.ts",
          },
        });
      }

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
      NodeAssert.ok(config?.onEvent);
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
      emit({
        id: "evt-copilot-idle-after-bad-event",
        timestamp,
        parentId: null,
        type: "session.idle",
        data: {
          aborted: false,
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
      NodeAssert.equal(runtimeError, undefined);
      NodeAssert.equal(toolProgress, undefined);
      NodeAssert.equal(completed?.type, "turn.completed");
      if (completed?.type === "turn.completed") {
        NodeAssert.equal(String(completed.turnId), String(turn.turnId));
        NodeAssert.equal(completed.payload.state, "completed");
      }

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("completes the active turn as failed when Copilot reports a session error", () =>
    Effect.gen(function* () {
      const adapter = yield* CopilotAdapter;
      const threadId = asThreadId("copilot-session-error-completes-active-turn");

      yield* adapter.startSession({
        provider: COPILOT_DRIVER,
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });

      const turn = yield* adapter.sendTurn({
        threadId,
        input: "trigger a provider session error",
        attachments: [],
      });

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) => Effect.sync(() => runtimeEvents.push(event))),
        Effect.forkChild,
      );
      yield* waitForSdkEventQueue();

      const config = runtimeMock.state.createSessionConfigs.at(-1);
      NodeAssert.ok(config?.onEvent);
      const timestamp = yield* nowIso;
      config.onEvent({
        id: "evt-copilot-session-error-turn-start",
        timestamp,
        parentId: null,
        type: "assistant.turn_start",
        data: {
          turnId: "sdk-turn-session-error",
        },
      } as SessionEvent);
      config.onEvent({
        id: "evt-copilot-session-error",
        timestamp,
        parentId: null,
        type: "session.error",
        data: {
          message: "Copilot runtime crashed",
        },
      } as SessionEvent);

      let completed: ProviderRuntimeEvent | undefined;
      for (let attempt = 0; attempt < 20 && completed === undefined; attempt += 1) {
        yield* waitForSdkEventQueue();
        completed = runtimeEvents.find(
          (event) =>
            event.type === "turn.completed" && String(event.turnId) === String(turn.turnId),
        );
      }
      yield* Fiber.interrupt(runtimeEventsFiber).pipe(Effect.ignore);

      const runtimeError = runtimeEvents.find((event) => event.type === "runtime.error");
      NodeAssert.equal(runtimeError?.type, "runtime.error");
      NodeAssert.equal(completed?.type, "turn.completed");
      if (completed?.type === "turn.completed") {
        NodeAssert.equal(completed.payload.state, "failed");
        NodeAssert.equal(completed.payload.errorMessage, "Copilot runtime crashed");
      }

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("emits one canonical turn completion for duplicate Copilot lifecycle events", () =>
    Effect.gen(function* () {
      const adapter = yield* CopilotAdapter;
      const threadId = asThreadId("copilot-duplicate-lifecycle-completion");

      yield* adapter.startSession({
        provider: COPILOT_DRIVER,
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });

      const turn = yield* adapter.sendTurn({
        threadId,
        input: "complete once",
        attachments: [],
      });

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) => Effect.sync(() => runtimeEvents.push(event))),
        Effect.forkChild,
      );
      yield* waitForSdkEventQueue();

      const config = runtimeMock.state.createSessionConfigs.at(-1);
      NodeAssert.ok(config?.onEvent);
      const emit = (event: SessionEvent) => config.onEvent?.(event);
      const timestamp = yield* nowIso;

      emit({
        id: "evt-copilot-duplicate-turn-start",
        timestamp,
        parentId: null,
        type: "assistant.turn_start",
        data: {
          turnId: "sdk-turn-duplicate-completion",
        },
      } as SessionEvent);
      emit({
        id: "evt-copilot-duplicate-turn-end",
        timestamp,
        parentId: null,
        type: "assistant.turn_end",
        data: {
          turnId: "sdk-turn-duplicate-completion",
        },
      } as SessionEvent);
      emit({
        id: "evt-copilot-duplicate-idle",
        timestamp,
        parentId: null,
        type: "session.idle",
        data: {
          aborted: false,
        },
      } as SessionEvent);
      emit({
        id: "evt-copilot-duplicate-turn-end-again",
        timestamp,
        parentId: null,
        type: "assistant.turn_end",
        data: {
          turnId: "sdk-turn-duplicate-completion",
        },
      } as SessionEvent);

      for (
        let attempt = 0;
        attempt < 20 &&
        runtimeEvents.filter((event) => event.type === "turn.completed").length === 0;
        attempt += 1
      ) {
        yield* waitForSdkEventQueue();
      }
      yield* waitForSdkEventQueue();
      yield* Fiber.interrupt(runtimeEventsFiber).pipe(Effect.ignore);

      const completions = runtimeEvents.filter(
        (event) => event.type === "turn.completed" && String(event.turnId) === String(turn.turnId),
      );
      NodeAssert.equal(completions.length, 1);
      NodeAssert.equal(completions[0]?.type, "turn.completed");
      if (completions[0]?.type === "turn.completed") {
        NodeAssert.equal(completions[0].payload.state, "completed");
      }

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("keeps one T3 turn active across multiple Copilot SDK loops until idle", () =>
    Effect.gen(function* () {
      const adapter = yield* CopilotAdapter;
      const threadId = asThreadId("copilot-multi-sdk-loop-before-idle");

      yield* adapter.startSession({
        provider: COPILOT_DRIVER,
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });

      const turn = yield* adapter.sendTurn({
        threadId,
        input: "continue through multiple sdk loops",
        attachments: [],
      });

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) => Effect.sync(() => runtimeEvents.push(event))),
        Effect.forkChild,
      );
      yield* waitForSdkEventQueue();

      const config = runtimeMock.state.createSessionConfigs.at(-1);
      NodeAssert.ok(config?.onEvent);
      const emit = (event: SessionEvent) => config.onEvent?.(event);
      const timestamp = yield* nowIso;

      emit({
        id: "evt-copilot-multi-loop-first-start",
        timestamp,
        parentId: null,
        type: "assistant.turn_start",
        data: {
          turnId: "sdk-turn-multi-loop-first",
        },
      } as SessionEvent);
      emit({
        id: "evt-copilot-multi-loop-first-end",
        timestamp,
        parentId: null,
        type: "assistant.turn_end",
        data: {
          turnId: "sdk-turn-multi-loop-first",
        },
      } as SessionEvent);
      emit({
        id: "evt-copilot-multi-loop-second-start",
        timestamp,
        parentId: null,
        type: "assistant.turn_start",
        data: {
          turnId: "sdk-turn-multi-loop-second",
        },
      } as SessionEvent);
      emit({
        id: "evt-copilot-multi-loop-message",
        timestamp,
        parentId: null,
        type: "assistant.message",
        data: {
          messageId: "message-multi-loop-second",
          content: "Finished after the second loop.",
          turnId: "sdk-turn-multi-loop-second",
        },
      } as SessionEvent);
      emit({
        id: "evt-copilot-multi-loop-second-end",
        timestamp,
        parentId: null,
        type: "assistant.turn_end",
        data: {
          turnId: "sdk-turn-multi-loop-second",
        },
      } as SessionEvent);

      yield* waitForSdkEventQueue();
      NodeAssert.equal(
        runtimeEvents.some((event) => event.type === "turn.completed"),
        false,
      );

      emit({
        id: "evt-copilot-multi-loop-idle",
        timestamp,
        parentId: null,
        type: "session.idle",
        data: {
          aborted: false,
        },
      } as SessionEvent);

      for (
        let attempt = 0;
        attempt < 20 &&
        !runtimeEvents.some(
          (event) =>
            event.type === "turn.completed" && String(event.turnId) === String(turn.turnId),
        );
        attempt += 1
      ) {
        yield* waitForSdkEventQueue();
      }
      yield* Fiber.interrupt(runtimeEventsFiber).pipe(Effect.ignore);

      const messageCompleted = runtimeEvents.find(
        (event) =>
          event.type === "item.completed" &&
          event.itemId === "copilot-message-message-multi-loop-second",
      );
      const completions = runtimeEvents.filter(
        (event) => event.type === "turn.completed" && String(event.turnId) === String(turn.turnId),
      );
      NodeAssert.equal(messageCompleted?.type, "item.completed");
      NodeAssert.equal(String(messageCompleted?.turnId), String(turn.turnId));
      NodeAssert.equal(completions.length, 1);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("ignores unmapped sdk turn starts without synthesizing a turn id", () =>
    Effect.gen(function* () {
      const adapter = yield* CopilotAdapter;
      const threadId = asThreadId("copilot-unmapped-sdk-turn-start");

      yield* adapter.startSession({
        provider: COPILOT_DRIVER,
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) => Effect.sync(() => runtimeEvents.push(event))),
        Effect.forkChild,
      );
      yield* waitForSdkEventQueue();

      const config = runtimeMock.state.createSessionConfigs.at(-1);
      NodeAssert.ok(config?.onEvent);
      const timestamp = yield* nowIso;

      config.onEvent({
        id: "evt-copilot-unmapped-turn-start",
        timestamp,
        parentId: null,
        type: "assistant.turn_start",
        data: {
          turnId: "sdk-turn-unmapped",
        },
      } as SessionEvent);

      yield* waitForSdkEventQueue();

      yield* Fiber.interrupt(runtimeEventsFiber).pipe(Effect.ignore);

      const runtimeWarning = runtimeEvents.find((event) => event.type === "runtime.warning");
      const runningState = runtimeEvents.find(
        (event) => event.type === "session.state.changed" && event.payload.state === "running",
      );
      NodeAssert.equal(runtimeWarning, undefined);
      NodeAssert.equal(runningState, undefined);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("does not remap an unmapped sdk turn_start to the latest completed turn", () =>
    Effect.gen(function* () {
      const adapter = yield* CopilotAdapter;
      const threadId = asThreadId("copilot-unmapped-sdk-turn-start-after-completion");

      yield* adapter.startSession({
        provider: COPILOT_DRIVER,
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) => Effect.sync(() => runtimeEvents.push(event))),
        Effect.forkChild,
      );
      yield* waitForSdkEventQueue();

      const config = runtimeMock.state.createSessionConfigs.at(-1);
      NodeAssert.ok(config?.onEvent);
      const emit = (event: SessionEvent) => config.onEvent?.(event);
      const timestamp = yield* nowIso;

      const firstTurn = yield* adapter.sendTurn({
        threadId,
        input: "first prompt",
        attachments: [],
      });

      emit({
        id: "evt-copilot-unmapped-after-complete-first-start",
        timestamp,
        parentId: null,
        type: "assistant.turn_start",
        data: {
          turnId: "sdk-turn-unmapped-after-complete-first",
        },
      } as SessionEvent);
      emit({
        id: "evt-copilot-unmapped-after-complete-first-end",
        timestamp,
        parentId: null,
        type: "assistant.turn_end",
        data: {
          turnId: "sdk-turn-unmapped-after-complete-first",
        },
      } as SessionEvent);
      emit({
        id: "evt-copilot-unmapped-after-complete-first-idle",
        timestamp,
        parentId: null,
        type: "session.idle",
        data: {
          aborted: false,
        },
      } as SessionEvent);

      for (
        let attempt = 0;
        attempt < 20 &&
        !runtimeEvents.some(
          (event) =>
            event.type === "turn.completed" && String(event.turnId) === String(firstTurn.turnId),
        );
        attempt += 1
      ) {
        yield* waitForSdkEventQueue();
      }

      const eventsBeforeSecondUnmappedStart = runtimeEvents.length;

      emit({
        id: "evt-copilot-unmapped-after-complete-second-start",
        timestamp,
        parentId: null,
        type: "assistant.turn_start",
        data: {
          turnId: "sdk-turn-unmapped-after-complete-second",
        },
      } as SessionEvent);

      yield* waitForSdkEventQueue();

      yield* Fiber.interrupt(runtimeEventsFiber).pipe(Effect.ignore);

      const postSecondStartEvents = runtimeEvents.slice(eventsBeforeSecondUnmappedStart);

      const staleRunningState = postSecondStartEvents.find(
        (event) =>
          event.type === "session.state.changed" &&
          event.payload.state === "running" &&
          String(event.turnId) === String(firstTurn.turnId),
      );
      const runtimeWarning = postSecondStartEvents.find(
        (event) =>
          event.type === "runtime.warning" &&
          event.payload.message.includes("sdk-turn-unmapped-after-complete-second"),
      );

      NodeAssert.equal(runtimeWarning, undefined);
      NodeAssert.equal(staleRunningState, undefined);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("does not complete a queued turn from the previous Copilot idle event", () =>
    Effect.gen(function* () {
      const adapter = yield* CopilotAdapter;
      const threadId = asThreadId("copilot-queued-turn-idle-correlation");

      yield* adapter.startSession({
        provider: COPILOT_DRIVER,
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) => Effect.sync(() => runtimeEvents.push(event))),
        Effect.forkChild,
      );
      yield* waitForSdkEventQueue();

      const config = runtimeMock.state.createSessionConfigs.at(-1);
      NodeAssert.ok(config?.onEvent);
      const emit = (event: SessionEvent) => config.onEvent?.(event);
      const timestamp = yield* nowIso;

      const firstTurn = yield* adapter.sendTurn({
        threadId,
        input: "first prompt",
        attachments: [],
      });
      emit({
        id: "evt-copilot-queued-first-turn-start",
        timestamp,
        parentId: null,
        type: "assistant.turn_start",
        data: {
          turnId: "sdk-turn-queued-first",
        },
      } as SessionEvent);

      for (
        let attempt = 0;
        attempt < 20 &&
        !runtimeEvents.some(
          (event) =>
            event.type === "session.state.changed" &&
            String(event.turnId) === String(firstTurn.turnId) &&
            event.payload.state === "running",
        );
        attempt += 1
      ) {
        yield* waitForSdkEventQueue();
      }
      NodeAssert.equal(
        runtimeEvents.some(
          (event) =>
            event.type === "session.state.changed" &&
            String(event.turnId) === String(firstTurn.turnId) &&
            event.payload.state === "running",
        ),
        true,
      );

      const secondTurn = yield* adapter.sendTurn({
        threadId,
        input: "second prompt",
        attachments: [],
      });
      emit({
        id: "evt-copilot-queued-first-turn-end",
        timestamp,
        parentId: null,
        type: "assistant.turn_end",
        data: {
          turnId: "sdk-turn-queued-first",
        },
      } as SessionEvent);
      emit({
        id: "evt-copilot-queued-first-idle",
        timestamp,
        parentId: null,
        type: "session.idle",
        data: {
          aborted: false,
        },
      } as SessionEvent);

      for (
        let attempt = 0;
        attempt < 20 &&
        !runtimeEvents.some(
          (event) =>
            event.type === "turn.completed" && String(event.turnId) === String(firstTurn.turnId),
        );
        attempt += 1
      ) {
        yield* waitForSdkEventQueue();
      }
      yield* waitForSdkEventQueue();

      const completionsAfterFirstIdle = runtimeEvents.filter(
        (event) => event.type === "turn.completed",
      );
      NodeAssert.equal(
        completionsAfterFirstIdle.filter(
          (event) => String(event.turnId) === String(firstTurn.turnId),
        ).length,
        1,
      );
      NodeAssert.equal(
        completionsAfterFirstIdle.filter(
          (event) => String(event.turnId) === String(secondTurn.turnId),
        ).length,
        0,
      );
      const latestEventAfterFirstIdle = runtimeEvents.at(-1);
      NodeAssert.equal(latestEventAfterFirstIdle?.type, "session.state.changed");
      NodeAssert.equal(latestEventAfterFirstIdle.payload.state, "running");

      emit({
        id: "evt-copilot-queued-second-turn-start",
        timestamp,
        parentId: null,
        type: "assistant.turn_start",
        data: {
          turnId: "sdk-turn-queued-second",
        },
      } as SessionEvent);
      emit({
        id: "evt-copilot-queued-second-turn-end",
        timestamp,
        parentId: null,
        type: "assistant.turn_end",
        data: {
          turnId: "sdk-turn-queued-second",
        },
      } as SessionEvent);
      emit({
        id: "evt-copilot-queued-second-idle",
        timestamp,
        parentId: null,
        type: "session.idle",
        data: {
          aborted: false,
        },
      } as SessionEvent);

      for (
        let attempt = 0;
        attempt < 20 &&
        runtimeEvents.filter(
          (event) =>
            event.type === "turn.completed" && String(event.turnId) === String(secondTurn.turnId),
        ).length === 0;
        attempt += 1
      ) {
        yield* waitForSdkEventQueue();
      }
      yield* Fiber.interrupt(runtimeEventsFiber).pipe(Effect.ignore);

      const secondCompletions = runtimeEvents.filter(
        (event) =>
          event.type === "turn.completed" && String(event.turnId) === String(secondTurn.turnId),
      );
      NodeAssert.equal(secondCompletions.length, 1);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("does not let stale sdk turn_start steal the next queued turn id", () =>
    Effect.gen(function* () {
      const adapter = yield* CopilotAdapter;
      const threadId = asThreadId("copilot-stale-turn-start-does-not-steal-queue");

      yield* adapter.startSession({
        provider: COPILOT_DRIVER,
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) => Effect.sync(() => runtimeEvents.push(event))),
        Effect.forkChild,
      );
      yield* waitForSdkEventQueue();

      const config = runtimeMock.state.createSessionConfigs.at(-1);
      NodeAssert.ok(config?.onEvent);
      const emit = (event: SessionEvent) => config.onEvent?.(event);
      const timestamp = yield* nowIso;

      const firstTurn = yield* adapter.sendTurn({
        threadId,
        input: "first prompt",
        attachments: [],
      });
      const secondTurn = yield* adapter.sendTurn({
        threadId,
        input: "second prompt",
        attachments: [],
      });

      emit({
        id: "evt-copilot-stale-steal-first-start",
        timestamp,
        parentId: null,
        type: "assistant.turn_start",
        data: {
          turnId: "sdk-turn-first",
        },
      } as SessionEvent);
      emit({
        id: "evt-copilot-stale-steal-stale-start",
        timestamp,
        parentId: null,
        type: "assistant.turn_start",
        data: {
          turnId: "sdk-turn-stale",
        },
      } as SessionEvent);

      yield* waitForSdkEventQueue();

      emit({
        id: "evt-copilot-stale-steal-first-end",
        timestamp,
        parentId: null,
        type: "assistant.turn_end",
        data: {
          turnId: "sdk-turn-first",
        },
      } as SessionEvent);
      emit({
        id: "evt-copilot-stale-steal-first-idle",
        timestamp,
        parentId: null,
        type: "session.idle",
        data: {
          aborted: false,
        },
      } as SessionEvent);
      emit({
        id: "evt-copilot-stale-steal-second-start",
        timestamp,
        parentId: null,
        type: "assistant.turn_start",
        data: {
          turnId: "sdk-turn-second",
        },
      } as SessionEvent);
      emit({
        id: "evt-copilot-stale-steal-second-end",
        timestamp,
        parentId: null,
        type: "assistant.turn_end",
        data: {
          turnId: "sdk-turn-second",
        },
      } as SessionEvent);
      emit({
        id: "evt-copilot-stale-steal-second-idle",
        timestamp,
        parentId: null,
        type: "session.idle",
        data: {
          aborted: false,
        },
      } as SessionEvent);

      for (
        let attempt = 0;
        attempt < 20 &&
        !runtimeEvents.some(
          (event) =>
            event.type === "turn.completed" && String(event.turnId) === String(secondTurn.turnId),
        );
        attempt += 1
      ) {
        yield* waitForSdkEventQueue();
      }

      yield* Fiber.interrupt(runtimeEventsFiber).pipe(Effect.ignore);

      const staleWarning = runtimeEvents.find(
        (event) =>
          event.type === "runtime.warning" && event.payload.message.includes("sdk-turn-stale"),
      );
      NodeAssert.equal(staleWarning, undefined);

      const firstCompletion = runtimeEvents.find(
        (event) =>
          event.type === "turn.completed" && String(event.turnId) === String(firstTurn.turnId),
      );
      const secondCompletion = runtimeEvents.find(
        (event) =>
          event.type === "turn.completed" && String(event.turnId) === String(secondTurn.turnId),
      );
      NodeAssert.equal(firstCompletion?.type, "turn.completed");
      NodeAssert.equal(secondCompletion?.type, "turn.completed");

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("does not let timestamped sdk replay consume a freshly queued turn", () =>
    Effect.gen(function* () {
      const adapter = yield* CopilotAdapter;
      const threadId = asThreadId("copilot-timestamped-replay-does-not-steal-queue");

      yield* adapter.startSession({
        provider: COPILOT_DRIVER,
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) => Effect.sync(() => runtimeEvents.push(event))),
        Effect.forkChild,
      );
      yield* waitForSdkEventQueue();

      const config = runtimeMock.state.createSessionConfigs.at(-1);
      NodeAssert.ok(config?.onEvent);
      const emit = (event: SessionEvent) => config.onEvent?.(event);
      const replayTimestamp = "1900-01-01T00:00:00.000Z";

      const turn = yield* adapter.sendTurn({
        threadId,
        input: "fresh prompt",
        attachments: [],
      });
      const liveTimestamp = yield* nowIso;

      for (const sdkTurnId of ["1", "2", "3"]) {
        emit({
          id: `evt-copilot-replay-turn-${sdkTurnId}`,
          timestamp: replayTimestamp,
          parentId: null,
          type: "assistant.turn_start",
          data: {
            turnId: sdkTurnId,
          },
        } as SessionEvent);
      }
      emit({
        id: "evt-copilot-replay-live-start",
        timestamp: liveTimestamp,
        parentId: null,
        type: "assistant.turn_start",
        data: {
          turnId: "sdk-turn-live-after-replay",
        },
      } as SessionEvent);
      emit({
        id: "evt-copilot-replay-live-end",
        timestamp: liveTimestamp,
        parentId: null,
        type: "assistant.turn_end",
        data: {
          turnId: "sdk-turn-live-after-replay",
        },
      } as SessionEvent);
      emit({
        id: "evt-copilot-replay-live-idle",
        timestamp: liveTimestamp,
        parentId: null,
        type: "session.idle",
        data: {
          aborted: false,
        },
      } as SessionEvent);

      for (
        let attempt = 0;
        attempt < 20 &&
        !runtimeEvents.some(
          (event) =>
            event.type === "turn.completed" && String(event.turnId) === String(turn.turnId),
        );
        attempt += 1
      ) {
        yield* waitForSdkEventQueue();
      }

      yield* Fiber.interrupt(runtimeEventsFiber).pipe(Effect.ignore);

      const replayWarnings = runtimeEvents.filter(
        (event) =>
          event.type === "runtime.warning" && event.payload.message.includes("Copilot turn start"),
      );
      const completions = runtimeEvents.filter(
        (event) => event.type === "turn.completed" && String(event.turnId) === String(turn.turnId),
      );
      NodeAssert.equal(replayWarnings.length, 0);
      NodeAssert.equal(completions.length, 1);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect(
    "maps the next turn correctly after idle-only completion clears stale sdk turn state",
    () =>
      Effect.gen(function* () {
        const adapter = yield* CopilotAdapter;
        const threadId = asThreadId("copilot-idle-only-next-turn-mapping");

        yield* adapter.startSession({
          provider: COPILOT_DRIVER,
          threadId,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
        });

        const runtimeEvents: ProviderRuntimeEvent[] = [];
        const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
          Stream.runForEach((event) => Effect.sync(() => runtimeEvents.push(event))),
          Effect.forkChild,
        );
        yield* waitForSdkEventQueue();

        const config = runtimeMock.state.createSessionConfigs.at(-1);
        NodeAssert.ok(config?.onEvent);
        const emit = (event: SessionEvent) => config.onEvent?.(event);
        const timestamp = yield* nowIso;

        const firstTurn = yield* adapter.sendTurn({
          threadId,
          input: "first prompt",
          attachments: [],
        });
        emit({
          id: "evt-copilot-idle-only-first-start",
          timestamp,
          parentId: null,
          type: "assistant.turn_start",
          data: {
            turnId: "sdk-turn-idle-only-first",
          },
        } as SessionEvent);
        emit({
          id: "evt-copilot-idle-only-first-idle",
          timestamp,
          parentId: null,
          type: "session.idle",
          data: {
            aborted: false,
          },
        } as SessionEvent);

        for (
          let attempt = 0;
          attempt < 20 &&
          !runtimeEvents.some(
            (event) =>
              event.type === "turn.completed" && String(event.turnId) === String(firstTurn.turnId),
          );
          attempt += 1
        ) {
          yield* waitForSdkEventQueue();
        }

        const secondTurn = yield* adapter.sendTurn({
          threadId,
          input: "second prompt",
          attachments: [],
        });
        emit({
          id: "evt-copilot-idle-only-second-start",
          timestamp,
          parentId: null,
          type: "assistant.turn_start",
          data: {
            turnId: "sdk-turn-idle-only-second",
          },
        } as SessionEvent);
        emit({
          id: "evt-copilot-idle-only-second-end",
          timestamp,
          parentId: null,
          type: "assistant.turn_end",
          data: {
            turnId: "sdk-turn-idle-only-second",
          },
        } as SessionEvent);
        emit({
          id: "evt-copilot-idle-only-second-idle",
          timestamp,
          parentId: null,
          type: "session.idle",
          data: {
            aborted: false,
          },
        } as SessionEvent);

        for (
          let attempt = 0;
          attempt < 20 &&
          !runtimeEvents.some(
            (event) =>
              event.type === "turn.completed" && String(event.turnId) === String(secondTurn.turnId),
          );
          attempt += 1
        ) {
          yield* waitForSdkEventQueue();
        }

        yield* Fiber.interrupt(runtimeEventsFiber).pipe(Effect.ignore);

        const firstTurnCompletions = runtimeEvents.filter(
          (event) =>
            event.type === "turn.completed" && String(event.turnId) === String(firstTurn.turnId),
        );
        const secondTurnCompletions = runtimeEvents.filter(
          (event) =>
            event.type === "turn.completed" && String(event.turnId) === String(secondTurn.turnId),
        );
        NodeAssert.equal(firstTurnCompletions.length, 1);
        NodeAssert.equal(secondTurnCompletions.length, 1);

        yield* adapter.stopSession(threadId);
      }),
  );

  it.effect("drains queued SDK events before disconnecting on stop", () =>
    Effect.gen(function* () {
      const adapter = yield* CopilotAdapter;
      const threadId = asThreadId("copilot-stop-drains-event-chain");

      yield* adapter.startSession({
        provider: COPILOT_DRIVER,
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });

      const turn = yield* adapter.sendTurn({
        threadId,
        input: "finish while stop is requested",
        attachments: [],
      });

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) => Effect.sync(() => runtimeEvents.push(event))),
        Effect.forkChild,
      );
      yield* waitForSdkEventQueue();

      let releaseNativeWrite: () => void = () => undefined;
      runtimeMock.state.nativeWriteGate = new Promise<void>((resolve) => {
        releaseNativeWrite = resolve;
      });

      const config = runtimeMock.state.createSessionConfigs.at(-1);
      NodeAssert.ok(config?.onEvent);
      const emit = (event: SessionEvent) => config.onEvent?.(event);
      const timestamp = yield* nowIso;

      emit({
        id: "evt-copilot-stop-drain-turn-start",
        timestamp,
        parentId: null,
        type: "assistant.turn_start",
        data: {
          turnId: "sdk-turn-stop-drain",
        },
      } as SessionEvent);
      emit({
        id: "evt-copilot-stop-drain-idle",
        timestamp,
        parentId: null,
        type: "session.idle",
        data: {
          aborted: false,
        },
      } as SessionEvent);

      const stopFiber = yield* adapter.stopSession(threadId).pipe(Effect.forkChild);
      for (
        let attempt = 0;
        attempt < 20 && runtimeMock.state.nativeWriteCalls === 0;
        attempt += 1
      ) {
        yield* waitForSdkEventQueue();
      }

      const disconnectsBeforeDrain = runtimeMock.state.lastSession.disconnect.mock.calls.length;
      releaseNativeWrite();
      yield* Fiber.join(stopFiber);

      for (
        let attempt = 0;
        attempt < 20 && !runtimeEvents.some((event) => event.type === "turn.completed");
        attempt += 1
      ) {
        yield* waitForSdkEventQueue();
      }
      yield* Fiber.interrupt(runtimeEventsFiber).pipe(Effect.ignore);

      NodeAssert.equal(runtimeMock.state.nativeWriteCalls > 0, true);
      NodeAssert.equal(disconnectsBeforeDrain, 0);
      NodeAssert.equal(runtimeMock.state.lastSession.disconnect.mock.calls.length, 1);
      NodeAssert.equal(runtimeMock.state.stopCalls, 1);

      const completed = runtimeEvents.find((event) => event.type === "turn.completed");
      NodeAssert.equal(completed?.type, "turn.completed");
      if (completed?.type === "turn.completed") {
        NodeAssert.equal(String(completed.turnId), String(turn.turnId));
        NodeAssert.equal(completed.payload.state, "completed");
      }
    }),
  );

  it.effect("resolves open permission requests when stopping a session", () =>
    Effect.gen(function* () {
      const adapter = yield* CopilotAdapter;
      const threadId = asThreadId("copilot-stop-resolves-permission-request");

      yield* adapter.startSession({
        provider: COPILOT_DRIVER,
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) => Effect.sync(() => runtimeEvents.push(event))),
        Effect.forkChild,
      );
      yield* waitForSdkEventQueue();

      const config = runtimeMock.state.createSessionConfigs.at(-1);
      NodeAssert.ok(config?.onEvent);
      NodeAssert.ok(config.onPermissionRequest);
      const permissionRequest: PermissionRequest = {
        kind: "shell",
        toolCallId: "tool-stop-open-permission",
        fullCommandText: "git status",
        intention: "Check repository status",
        commands: [{ identifier: "git", readOnly: true }],
        possiblePaths: [],
        possibleUrls: [],
        hasWriteFileRedirection: false,
        canOfferSessionApproval: true,
      };
      const requestId = "permission-stop-open";
      void config.onPermissionRequest(permissionRequest, {
        sessionId: runtimeMock.state.lastSession.sessionId,
      });
      const timestamp = yield* nowIso;
      config.onEvent({
        id: "evt-copilot-stop-open-permission",
        timestamp,
        parentId: null,
        type: "permission.requested",
        data: {
          requestId,
          permissionRequest,
        },
      } as SessionEvent);

      let opened: ProviderRuntimeEvent | undefined;
      for (let attempt = 0; attempt < 20 && opened === undefined; attempt += 1) {
        yield* waitForSdkEventQueue();
        opened = runtimeEvents.find(
          (event) => event.type === "request.opened" && String(event.requestId) === requestId,
        );
      }
      NodeAssert.equal(opened?.type, "request.opened");

      yield* adapter.stopSession(threadId);
      let resolved: ProviderRuntimeEvent | undefined;
      for (let attempt = 0; attempt < 20 && resolved === undefined; attempt += 1) {
        yield* waitForSdkEventQueue();
        resolved = runtimeEvents.find(
          (event) => event.type === "request.resolved" && String(event.requestId) === requestId,
        );
      }
      yield* Fiber.interrupt(runtimeEventsFiber).pipe(Effect.ignore);

      NodeAssert.equal(resolved?.type, "request.resolved");
      if (resolved?.type === "request.resolved") {
        NodeAssert.equal(resolved.payload.decision, "reject");
        NodeAssert.deepStrictEqual(resolved.payload.resolution, { kind: "reject" });
      }
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

      NodeAssert.equal(result._tag, "Failure");
      const aborted = runtimeEvents.find((event) => event.type === "turn.aborted");
      const completed = runtimeEvents.find((event) => event.type === "turn.completed");

      NodeAssert.equal(aborted?.type, "turn.aborted");
      NodeAssert.equal(completed?.type, "turn.completed");
      if (aborted?.type === "turn.aborted" && completed?.type === "turn.completed") {
        NodeAssert.equal(String(completed.turnId), String(aborted.turnId));
        NodeAssert.equal(completed.payload.state, "failed");
        NodeAssert.equal(completed.payload.errorMessage, "Copilot send rejected");
      }

      yield* adapter.stopSession(threadId);
    }),
  );
});
