import * as NodeAssert from "node:assert/strict";
import * as NodeTimersPromises from "node:timers/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import type {
  CopilotClient,
  CopilotSession,
  MessageOptions,
  PermissionRequest,
  SessionConfig,
  SessionEvent,
} from "@github/copilot-sdk";
import { beforeEach, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";

import {
  ApprovalRequestId,
  CopilotSettings,
  EnvironmentId,
  type ProviderRuntimeEvent,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import type { CopilotAdapterShape } from "../Services/CopilotAdapter.ts";
import { type EventNdjsonLogger } from "./EventNdjsonLogger.ts";
import { makeCopilotAdapter } from "./CopilotAdapter.ts";

const decodeCopilotSettings = Schema.decodeSync(CopilotSettings);
const encodeUnknownJson = Schema.encodeUnknownSync(Schema.UnknownFromJsonString);

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
      history: {
        truncate: vi.fn(async () => ({ eventsRemoved: 0 })),
      },
      plan: {
        read: vi.fn(async () => ({ exists: false, content: null, path: null })),
      },
      tasks: {
        list: vi.fn(
          async (): Promise<{ tasks: Array<Record<string, unknown>> }> => ({
            tasks: [],
          }),
        ),
      },
    },
    disconnect: vi.fn(async () => undefined),
    getEvents: vi.fn(async (): Promise<SessionEvent[]> => []),
    setModel: vi.fn(async () => undefined),
    send: vi.fn(async (_messageOptions: MessageOptions): Promise<string | undefined> => undefined),
    abort: vi.fn(async () => undefined),
  });

  const state = {
    startCalls: 0,
    stopCalls: 0,
    forceStopCalls: 0,
    stopErrors: [] as Error[],
    nativeWriteCalls: 0,
    nativeWritePayloads: [] as unknown[],
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
      state.forceStopCalls = 0;
      state.stopErrors = [];
      state.nativeWriteCalls = 0;
      state.nativeWritePayloads = [];
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
          return runtimeMock.state.stopErrors;
        }),
        forceStop: vi.fn(async () => {
          runtimeMock.state.forceStopCalls += 1;
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
  McpProviderSession.clearAllMcpProviderSessions();
});

const nativeEventLogger = {
  filePath: "memory://copilot-native-events.ndjson",
  write: vi.fn((event: unknown) =>
    Effect.promise(async () => {
      runtimeMock.state.nativeWriteCalls += 1;
      runtimeMock.state.nativeWritePayloads.push(event);
      const gate = runtimeMock.state.nativeWriteGate;
      if (gate) {
        await gate;
      }
    }),
  ),
  close: vi.fn(() => Effect.void),
} satisfies EventNdjsonLogger;

function setMcpProviderSession(threadId: ThreadId, accessToken: string): void {
  McpProviderSession.setMcpProviderSession({
    environmentId: EnvironmentId.make("copilot-adapter-test-environment"),
    threadId,
    providerSessionId: `mcp-provider-${threadId}`,
    providerInstanceId: COPILOT_INSTANCE_ID,
    endpoint: "http://127.0.0.1:43123/mcp",
    authorizationHeader: `Bearer ${accessToken}`,
  });
}

const CopilotAdapterTestLayer = Layer.effect(
  CopilotAdapter,
  makeCopilotAdapter(decodeCopilotSettings({}), {
    nativeEventLogger,
    turnEndIdleFallbackDelayMs: 25,
  }),
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

  it.effect("correlates bootstrap auto-approvals before replaying early permission events", () =>
    Effect.gen(function* () {
      const permissionRequest = {
        kind: "write",
        toolCallId: "tool-bootstrap-auto-approved-write",
        fileName: "README.md",
        diff: "--- a/README.md\n+++ b/README.md\n@@\n-old\n+new\n",
        intention: "Update README",
        canOfferSessionApproval: true,
      } as Extract<PermissionRequest, { kind: "write" }>;
      const bootstrapTimestamp = yield* nowIso;
      runtimeMock.state.createSessionImpl = async (config: SessionConfig) => {
        NodeAssert.ok(config.onEvent);
        NodeAssert.ok(config.onPermissionRequest);
        config.onEvent({
          id: "evt-copilot-bootstrap-auto-approved-requested",
          timestamp: bootstrapTimestamp,
          parentId: null,
          type: "permission.requested",
          data: {
            requestId: "permission-bootstrap-auto-approved",
            permissionRequest,
            promptRequest: undefined,
          },
        } as unknown as SessionEvent);
        const result = await config.onPermissionRequest(permissionRequest, {
          sessionId: runtimeMock.state.lastSession.sessionId,
        });
        config.onEvent({
          id: "evt-copilot-bootstrap-auto-approved-completed",
          timestamp: bootstrapTimestamp,
          parentId: null,
          type: "permission.completed",
          data: {
            requestId: "permission-bootstrap-auto-approved",
            result,
          },
        } as SessionEvent);
        return runtimeMock.state.lastSession as unknown as CopilotSession;
      };

      const adapter = yield* CopilotAdapter;
      const threadId = asThreadId("copilot-bootstrap-permission-correlation");
      yield* adapter.startSession({
        provider: COPILOT_DRIVER,
        threadId,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const turn = yield* adapter.sendTurn({
        threadId,
        input: "repeat the bootstrap write",
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
      const timestamp = yield* nowIso;
      config.onEvent({
        id: "evt-copilot-post-bootstrap-turn-start",
        timestamp,
        parentId: null,
        type: "assistant.turn_start",
        data: { turnId: "sdk-turn-post-bootstrap-write" },
      } as SessionEvent);
      const result = yield* Effect.promise(() =>
        Promise.resolve(
          config.onPermissionRequest?.(permissionRequest, {
            sessionId: runtimeMock.state.lastSession.sessionId,
          }),
        ),
      );
      config.onEvent({
        id: "evt-copilot-post-bootstrap-write-requested",
        timestamp,
        parentId: null,
        type: "permission.requested",
        data: {
          requestId: "permission-post-bootstrap-auto-approved",
          permissionRequest,
          promptRequest: undefined,
        },
      } as unknown as SessionEvent);
      config.onEvent({
        id: "evt-copilot-post-bootstrap-write-completed",
        timestamp,
        parentId: null,
        type: "permission.completed",
        data: {
          requestId: "permission-post-bootstrap-auto-approved",
          result,
        },
      } as SessionEvent);

      let diffUpdated: ProviderRuntimeEvent | undefined;
      for (let attempt = 0; attempt < 20 && diffUpdated === undefined; attempt += 1) {
        yield* waitForSdkEventQueue();
        diffUpdated = runtimeEvents.find((event) => event.type === "turn.diff.updated");
      }
      yield* Fiber.interrupt(runtimeEventsFiber).pipe(Effect.ignore);

      NodeAssert.equal(diffUpdated?.type, "turn.diff.updated");
      if (diffUpdated?.type === "turn.diff.updated") {
        NodeAssert.equal(String(diffUpdated.turnId), String(turn.turnId));
        NodeAssert.equal(diffUpdated.payload.unifiedDiff, permissionRequest.diff.trim());
      }
      NodeAssert.equal(
        runtimeEvents.some((event) => event.type === "request.opened"),
        false,
      );
      NodeAssert.equal(
        runtimeEvents.filter(
          (event) =>
            event.type === "request.resolved" &&
            String(event.requestId) === "permission-post-bootstrap-auto-approved",
        ).length,
        1,
      );

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("maps correlated MCP lifecycle events without leaking auth secrets", () =>
    Effect.gen(function* () {
      const adapter = yield* CopilotAdapter;
      const threadId = asThreadId("copilot-mcp-event-mapping");
      const accessToken = "copilot-mcp-event-token-secret";
      const clientSecret = "copilot-mcp-client-secret";
      const metadataSecret = "copilot-mcp-metadata-secret";
      const urlSecret = "copilot-mcp-url-secret";
      setMcpProviderSession(threadId, accessToken);

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
      NodeAssert.ok(config.onMcpAuthRequest);
      const timestamp = yield* nowIso;
      const emit = (event: SessionEvent) => config.onEvent?.(event);

      const tokenResult = yield* Effect.promise(() =>
        Promise.resolve(
          config.onMcpAuthRequest?.(
            {
              requestId: "mcp-oauth-token",
              serverName: "t3-code",
              serverUrl: "http://127.0.0.1:43123/mcp",
              reason: "initial",
              resourceMetadata: `{"private":"${metadataSecret}"}`,
              staticClientConfig: {
                clientId: "t3-code",
                clientSecret,
              },
            },
            { sessionId: threadId },
          ),
        ),
      );
      NodeAssert.deepStrictEqual(tokenResult, {
        kind: "token",
        accessToken,
        tokenType: "Bearer",
      });

      emit({
        id: "evt-mcp-oauth-required-token",
        timestamp,
        parentId: null,
        type: "mcp.oauth_required",
        ephemeral: true,
        data: {
          requestId: "mcp-oauth-token",
          serverName: "t3-code",
          serverUrl: `http://127.0.0.1:43123/mcp?credential=${urlSecret}`,
          reason: "initial",
          resourceMetadata: `{"private":"${metadataSecret}"}`,
          staticClientConfig: {
            clientId: "t3-code",
            clientSecret,
          },
          wwwAuthenticateParams: {
            scope: "preview:read",
          },
        },
      } as SessionEvent);
      emit({
        id: "evt-mcp-oauth-completed-token",
        timestamp,
        parentId: null,
        type: "mcp.oauth_completed",
        ephemeral: true,
        data: {
          requestId: "mcp-oauth-token",
          outcome: "token",
        },
      } as SessionEvent);
      emit({
        id: "evt-mcp-oauth-required-cancelled",
        timestamp,
        parentId: null,
        type: "mcp.oauth_required",
        ephemeral: true,
        data: {
          requestId: "mcp-oauth-cancelled",
          serverName: "external-oauth",
          serverUrl: `https://mcp.example.test/rpc?credential=${urlSecret}`,
          reason: "refresh",
          resourceMetadata: `{"private":"${metadataSecret}"}`,
          staticClientConfig: {
            clientId: "external",
            clientSecret,
          },
          wwwAuthenticateParams: {
            error: "invalid_token",
          },
        },
      } as SessionEvent);
      emit({
        id: "evt-mcp-oauth-completed-cancelled",
        timestamp,
        parentId: null,
        type: "mcp.oauth_completed",
        ephemeral: true,
        data: {
          requestId: "mcp-oauth-cancelled",
          outcome: "cancelled",
        },
      } as SessionEvent);
      emit({
        id: "evt-mcp-headers-required",
        timestamp,
        parentId: null,
        type: "mcp.headers_refresh_required",
        ephemeral: true,
        data: {
          requestId: "mcp-headers-refresh",
          serverName: "dynamic-headers",
          serverUrl: `https://mcp.example.test/rpc?credential=${urlSecret}`,
          reason: "auth-failed",
        },
      } as SessionEvent);
      emit({
        id: "evt-mcp-headers-completed",
        timestamp,
        parentId: null,
        type: "mcp.headers_refresh_completed",
        ephemeral: true,
        data: {
          requestId: "mcp-headers-refresh",
          outcome: "none",
        },
      } as SessionEvent);

      for (
        let attempt = 0;
        attempt < 20 &&
        runtimeEvents.filter(
          (event) => event.type === "mcp.status.updated" || event.type === "mcp.oauth.completed",
        ).length < 6;
        attempt += 1
      ) {
        yield* waitForSdkEventQueue();
      }
      yield* Fiber.interrupt(runtimeEventsFiber).pipe(Effect.ignore);

      const tokenCompletion = runtimeEvents.find(
        (event) =>
          event.type === "mcp.oauth.completed" && String(event.requestId) === "mcp-oauth-token",
      );
      NodeAssert.equal(tokenCompletion?.type, "mcp.oauth.completed");
      if (tokenCompletion?.type === "mcp.oauth.completed") {
        NodeAssert.deepStrictEqual(tokenCompletion.payload, {
          success: true,
          name: "t3-code",
        });
        NodeAssert.equal(tokenCompletion.providerRefs?.providerRequestId, "mcp-oauth-token");
      }

      const cancelledCompletion = runtimeEvents.find(
        (event) =>
          event.type === "mcp.oauth.completed" && String(event.requestId) === "mcp-oauth-cancelled",
      );
      NodeAssert.equal(cancelledCompletion?.type, "mcp.oauth.completed");
      if (cancelledCompletion?.type === "mcp.oauth.completed") {
        NodeAssert.deepStrictEqual(cancelledCompletion.payload, {
          success: false,
          name: "external-oauth",
          error: "invalid_token",
        });
        NodeAssert.equal(
          cancelledCompletion.providerRefs?.providerRequestId,
          "mcp-oauth-cancelled",
        );
      }

      const headerStatuses = runtimeEvents.filter(
        (event) =>
          event.type === "mcp.status.updated" && String(event.requestId) === "mcp-headers-refresh",
      );
      NodeAssert.deepStrictEqual(
        headerStatuses.map((event) =>
          event.type === "mcp.status.updated" ? event.payload.status : undefined,
        ),
        [
          {
            lifecycle: "headers-refresh",
            state: "required",
            serverName: "dynamic-headers",
            reason: "auth-failed",
          },
          {
            lifecycle: "headers-refresh",
            state: "completed",
            outcome: "none",
            serverName: "dynamic-headers",
          },
        ],
      );

      const observableOutput = encodeUnknownJson({
        runtimeEvents,
        nativeWrites: runtimeMock.state.nativeWritePayloads,
      });
      for (const secret of [accessToken, clientSecret, metadataSecret, urlSecret]) {
        NodeAssert.equal(observableOutput.includes(secret), false);
      }

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

  it.effect("denies plan execution and emits the proposed plan for fresh sessions", () =>
    Effect.gen(function* () {
      const adapter = yield* CopilotAdapter;
      const threadId = asThreadId("copilot-plan-exit-policy-create");

      yield* adapter.startSession({
        provider: COPILOT_DRIVER,
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      const turn = yield* adapter.sendTurn({
        threadId,
        input: "Create a plan",
        attachments: [],
      });

      const config = runtimeMock.state.createSessionConfigs.at(-1);
      NodeAssert.ok(config?.onExitPlanModeRequest);
      NodeAssert.ok(config.onAutoModeSwitchRequest);
      NodeAssert.deepStrictEqual(
        yield* Effect.promise(() =>
          Promise.resolve(
            config.onExitPlanModeRequest?.(
              {
                summary: "Plan ready",
                planContent: "1. Inspect\n2. Implement",
                actions: ["exit_only", "interactive"],
                recommendedAction: "interactive",
              },
              {
                sessionId: runtimeMock.state.lastSession.sessionId,
              },
            ),
          ),
        ),
        { approved: false },
      );
      NodeAssert.equal(
        yield* Effect.promise(() =>
          Promise.resolve(
            config.onAutoModeSwitchRequest?.(
              { errorCode: "rate_limited" },
              { sessionId: runtimeMock.state.lastSession.sessionId },
            ),
          ),
        ),
        "yes",
      );

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) => Effect.sync(() => runtimeEvents.push(event))),
        Effect.forkChild,
      );
      yield* waitForSdkEventQueue();
      const timestamp = yield* nowIso;
      config.onEvent?.({
        id: "evt-copilot-exit-plan-requested",
        timestamp,
        parentId: null,
        type: "exit_plan_mode.requested",
        ephemeral: true,
        data: {
          requestId: "exit-plan-request-1",
          summary: "Plan ready",
          planContent: "1. Inspect\n2. Implement",
          actions: ["exit_only", "interactive"],
          recommendedAction: "interactive",
        },
      } as SessionEvent);
      yield* waitForSdkEventQueue();
      yield* Fiber.interrupt(runtimeEventsFiber).pipe(Effect.ignore);

      const proposed = runtimeEvents.find((event) => event.type === "turn.proposed.completed");
      NodeAssert.equal(proposed?.type, "turn.proposed.completed");
      if (proposed?.type === "turn.proposed.completed") {
        NodeAssert.equal(String(proposed.turnId), String(turn.turnId));
        NodeAssert.equal(proposed.payload.planMarkdown, "1. Inspect\n2. Implement");
      }

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

  it.effect("rolls back resumed history without local turn snapshots", () =>
    Effect.gen(function* () {
      const timestamp = yield* nowIso;
      runtimeMock.state.lastSession.getEvents.mockResolvedValue([
        {
          id: "persisted-root-user-1",
          timestamp,
          parentId: null,
          type: "user.message",
          data: { content: "first persisted prompt" },
        } as SessionEvent,
        {
          id: "persisted-assistant-1",
          timestamp,
          parentId: "persisted-root-user-1",
          type: "assistant.message",
          data: { content: "first response" },
        } as SessionEvent,
        {
          id: "persisted-subagent-user-1",
          timestamp,
          parentId: "persisted-assistant-1",
          type: "user.message",
          agentId: "subagent-1",
          data: { content: "subagent prompt" },
        } as SessionEvent,
        {
          id: "persisted-root-user-2",
          timestamp,
          parentId: "persisted-subagent-user-1",
          type: "user.message",
          data: { content: "second persisted prompt" },
        } as SessionEvent,
        {
          id: "persisted-subagent-user-2",
          timestamp,
          parentId: "persisted-root-user-2",
          type: "user.message",
          agentId: "subagent-2",
          data: { content: "another subagent prompt" },
        } as SessionEvent,
        {
          id: "persisted-root-user-3",
          timestamp,
          parentId: "persisted-subagent-user-2",
          type: "user.message",
          data: { content: "third persisted prompt" },
        } as SessionEvent,
      ]);

      const adapter = yield* CopilotAdapter;
      const threadId = asThreadId("copilot-resumed-history-rollback");
      yield* adapter.startSession({
        provider: COPILOT_DRIVER,
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
        resumeCursor: {
          schemaVersion: 1,
          sessionId: "persisted-copilot-session",
        },
      });

      NodeAssert.deepStrictEqual((yield* adapter.readThread(threadId)).turns, []);
      const snapshot = yield* adapter.rollbackThread(threadId, 2);

      NodeAssert.deepStrictEqual(runtimeMock.state.lastSession.rpc.history.truncate.mock.calls, [
        [{ eventId: "persisted-root-user-2" }],
      ]);
      NodeAssert.deepStrictEqual(snapshot.turns, []);

      runtimeMock.state.lastSession.getEvents.mockResolvedValueOnce([
        {
          id: "persisted-root-user-1",
          timestamp,
          parentId: null,
          type: "user.message",
          data: { content: "first persisted prompt" },
        } as SessionEvent,
      ]);
      const missingBoundaryError = yield* adapter.rollbackThread(threadId, 2).pipe(Effect.flip);
      NodeAssert.match(missingBoundaryError.message, /contains only 1 root user message/);
      NodeAssert.equal(runtimeMock.state.lastSession.rpc.history.truncate.mock.calls.length, 1);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("serializes rollback with SDK events and new sends", () =>
    Effect.gen(function* () {
      const adapter = yield* CopilotAdapter;
      const threadId = asThreadId("copilot-rollback-serialization");

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

      const firstTurn = yield* adapter.sendTurn({
        threadId,
        input: "first prompt",
        attachments: [],
      });
      config.onEvent?.({
        id: "rollback-serialization-start",
        timestamp,
        parentId: null,
        type: "assistant.turn_start",
        data: { turnId: "sdk-turn-first" },
      } as SessionEvent);
      config.onEvent?.({
        id: "rollback-serialization-end",
        timestamp,
        parentId: null,
        type: "assistant.turn_end",
        data: { turnId: "sdk-turn-first" },
      } as SessionEvent);
      config.onEvent?.({
        id: "rollback-serialization-idle",
        timestamp,
        parentId: null,
        type: "session.idle",
        data: { aborted: false },
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

      let markHistoryReadStarted!: () => void;
      const historyReadStarted = new Promise<void>((resolve) => {
        markHistoryReadStarted = resolve;
      });
      let resolveHistoryEvents!: (events: SessionEvent[]) => void;
      const historyEvents = new Promise<SessionEvent[]>((resolve) => {
        resolveHistoryEvents = resolve;
      });
      runtimeMock.state.lastSession.getEvents.mockImplementationOnce(async () => {
        markHistoryReadStarted();
        return historyEvents;
      });

      const rollbackFiber = yield* adapter.rollbackThread(threadId, 1).pipe(Effect.forkChild);
      yield* Effect.promise(() => historyReadStarted);

      runtimeMock.state.lastSession.send.mockResolvedValueOnce("user-message-new");
      const sendFiber = yield* adapter
        .sendTurn({
          threadId,
          input: "new prompt",
          attachments: [],
        })
        .pipe(Effect.forkChild);
      config.onEvent?.({
        id: "late-user-message",
        timestamp,
        parentId: null,
        type: "user.message",
        data: { content: "late event during rollback" },
      } as SessionEvent);
      yield* waitForSdkEventQueue();

      NodeAssert.equal(runtimeMock.state.lastSession.send.mock.calls.length, 1);
      resolveHistoryEvents([
        {
          id: "user-message-first",
          timestamp,
          parentId: null,
          type: "user.message",
          data: { content: "first prompt" },
        } as SessionEvent,
      ]);

      const rolledBack = yield* Fiber.join(rollbackFiber);
      const newTurn = yield* Fiber.join(sendFiber);
      NodeAssert.deepStrictEqual(rolledBack.turns, []);
      NodeAssert.deepStrictEqual(runtimeMock.state.lastSession.rpc.history.truncate.mock.calls, [
        [{ eventId: "user-message-first" }],
      ]);
      NodeAssert.deepStrictEqual(
        (yield* adapter.readThread(threadId)).turns.map((turn) => String(turn.id)),
        [String(newTurn.turnId)],
      );

      yield* Fiber.interrupt(runtimeEventsFiber).pipe(Effect.ignore);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("keeps assistant call usage on the turn without publishing context usage", () =>
    Effect.gen(function* () {
      const adapter = yield* CopilotAdapter;
      const threadId = asThreadId("copilot-assistant-call-usage");

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

      const turn = yield* adapter.sendTurn({
        threadId,
        input: "measure this turn",
        attachments: [],
      });
      const config = runtimeMock.state.createSessionConfigs.at(-1);
      NodeAssert.ok(config?.onEvent);
      const timestamp = yield* nowIso;
      config.onEvent({
        id: "evt-call-usage-turn-start",
        timestamp,
        parentId: null,
        type: "assistant.turn_start",
        data: { turnId: "sdk-turn-call-usage" },
      } as SessionEvent);
      config.onEvent({
        id: "evt-call-usage",
        timestamp,
        parentId: null,
        type: "assistant.usage",
        ephemeral: true,
        data: {
          inputTokens: 100,
          cacheReadTokens: 20,
          outputTokens: 5,
          duration: 250,
        },
      } as SessionEvent);
      yield* waitForSdkEventQueue();
      yield* adapter.stopSession(threadId);
      yield* waitForSdkEventQueue();
      yield* Fiber.interrupt(runtimeEventsFiber).pipe(Effect.ignore);

      NodeAssert.equal(
        runtimeEvents.some((event) => event.type === "thread.token-usage.updated"),
        false,
      );
      const completed = runtimeEvents.find(
        (event) => event.type === "turn.completed" && String(event.turnId) === String(turn.turnId),
      );
      NodeAssert.equal(completed?.type, "turn.completed");
      if (completed?.type === "turn.completed") {
        NodeAssert.deepStrictEqual(completed.payload.usage, {
          usedTokens: 125,
          lastUsedTokens: 125,
          inputTokens: 100,
          lastInputTokens: 100,
          cachedInputTokens: 20,
          lastCachedInputTokens: 20,
          outputTokens: 5,
          lastOutputTokens: 5,
          durationMs: 250,
        });
      }
    }),
  );

  it.effect("serializes each turn's model and mode through its SDK send", () =>
    Effect.gen(function* () {
      const adapter = yield* CopilotAdapter;
      const threadId = asThreadId("copilot-send-turn-configuration-serialization");

      yield* adapter.startSession({
        provider: COPILOT_DRIVER,
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });

      runtimeMock.state.lastSession.setModel.mockClear();
      runtimeMock.state.lastSession.rpc.mode.set.mockClear();
      runtimeMock.state.lastSession.send.mockClear();
      let markFirstModelStarted!: () => void;
      const firstModelStarted = new Promise<void>((resolve) => {
        markFirstModelStarted = resolve;
      });
      let releaseFirstModel!: () => void;
      const firstModelGate = new Promise<void>((resolve) => {
        releaseFirstModel = resolve;
      });
      runtimeMock.state.lastSession.setModel.mockImplementationOnce(async () => {
        markFirstModelStarted();
        await firstModelGate;
      });

      const firstTurnFiber = yield* adapter
        .sendTurn({
          threadId,
          input: "plan the first change",
          attachments: [],
          interactionMode: "plan",
          modelSelection: {
            instanceId: COPILOT_INSTANCE_ID,
            model: "claude-sonnet-4.6",
            options: [],
          },
        })
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => firstModelStarted);

      const secondTurnFiber = yield* adapter
        .sendTurn({
          threadId,
          input: "implement the second change",
          attachments: [],
          modelSelection: {
            instanceId: COPILOT_INSTANCE_ID,
            model: "gpt-4.1",
            options: [],
          },
        })
        .pipe(Effect.forkChild);
      yield* waitForSdkEventQueue();

      NodeAssert.equal(runtimeMock.state.lastSession.setModel.mock.calls.length, 1);
      NodeAssert.equal(runtimeMock.state.lastSession.rpc.mode.set.mock.calls.length, 0);
      NodeAssert.equal(runtimeMock.state.lastSession.send.mock.calls.length, 0);

      releaseFirstModel();
      yield* Fiber.join(firstTurnFiber);
      yield* Fiber.join(secondTurnFiber);

      NodeAssert.deepStrictEqual(runtimeMock.state.lastSession.setModel.mock.calls, [
        ["claude-sonnet-4.6", {}],
        ["gpt-4.1", {}],
      ]);
      NodeAssert.deepStrictEqual(runtimeMock.state.lastSession.rpc.mode.set.mock.calls, [
        [{ mode: "plan" }],
        [{ mode: "interactive" }],
      ]);
      NodeAssert.deepStrictEqual(
        runtimeMock.state.lastSession.send.mock.calls.map(([messageOptions]) => ({
          prompt: messageOptions.prompt,
          agentMode: messageOptions.agentMode,
        })),
        [
          { prompt: "plan the first change", agentMode: "plan" },
          { prompt: "implement the second change", agentMode: "interactive" },
        ],
      );

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

  it.effect("only aborts the matching active Copilot turn", () =>
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

      yield* adapter.interruptTurn(threadId, TurnId.make("stale-turn-id"));
      NodeAssert.equal(runtimeMock.state.lastSession.abort.mock.calls.length, 0);

      yield* adapter.interruptTurn(threadId, turn.turnId);
      NodeAssert.equal(runtimeMock.state.lastSession.abort.mock.calls.length, 1);
      yield* waitForSdkEventQueue();
      NodeAssert.equal(runtimeEvents.filter((event) => event.type === "turn.aborted").length, 0);

      const config = runtimeMock.state.createSessionConfigs.at(-1);
      NodeAssert.ok(config?.onEvent);
      const timestamp = yield* nowIso;
      config.onEvent({
        id: "evt-copilot-abort-turn-start",
        timestamp,
        parentId: null,
        type: "assistant.turn_start",
        data: {
          turnId: "sdk-turn-aborted-partial",
        },
      } as SessionEvent);
      config.onEvent({
        id: "evt-copilot-abort-message-delta",
        timestamp,
        parentId: null,
        ephemeral: true,
        type: "assistant.message_delta",
        data: {
          messageId: "message-aborted-partial",
          deltaContent: "Partial response before abort.",
        },
      } as SessionEvent);
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
      const assistantCompleted = runtimeEvents.find(
        (event) =>
          event.type === "item.completed" &&
          String(event.itemId) === "copilot-message-message-aborted-partial",
      );
      NodeAssert.equal(assistantCompleted?.type, "item.completed");
      if (assistantCompleted?.type === "item.completed") {
        NodeAssert.equal(assistantCompleted.payload.status, "failed");
      }
      const snapshot = (yield* adapter.readThread(threadId)).turns.find(
        (entry) => entry.id === turn.turnId,
      );
      NodeAssert.ok(snapshot);
      NodeAssert.deepStrictEqual(snapshot.items, [
        {
          type: "assistant_message",
          messageId: "message-aborted-partial",
          content: "Partial response before abort.",
        },
      ]);

      yield* adapter.interruptTurn(threadId, turn.turnId);
      yield* adapter.interruptTurn(threadId);
      NodeAssert.equal(runtimeMock.state.lastSession.abort.mock.calls.length, 1);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("completes an ended Copilot turn before attributing queued follow-up output", () =>
    Effect.gen(function* () {
      const adapter = yield* CopilotAdapter;
      const threadId = asThreadId("copilot-queued-follow-up-after-turn-end");

      yield* adapter.startSession({
        provider: COPILOT_DRIVER,
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });

      const firstTurn = yield* adapter.sendTurn({
        threadId,
        input: "first prompt",
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
        id: "evt-copilot-first-turn-start",
        timestamp,
        parentId: null,
        type: "assistant.turn_start",
        data: {
          turnId: "sdk-turn-first",
        },
      } as SessionEvent);
      emit({
        id: "evt-copilot-first-message",
        timestamp,
        parentId: null,
        type: "assistant.message",
        data: {
          turnId: "sdk-turn-first",
          messageId: "message-first",
          content: "First response.",
        },
      } as SessionEvent);
      emit({
        id: "evt-copilot-first-turn-end",
        timestamp,
        parentId: null,
        type: "assistant.turn_end",
        data: {
          turnId: "sdk-turn-first",
        },
      } as SessionEvent);

      const secondTurn = yield* adapter.sendTurn({
        threadId,
        input: "follow-up prompt",
        attachments: [],
      });
      yield* waitForSdkEventQueue();
      NodeAssert.deepStrictEqual(
        runtimeEvents
          .filter((event) => event.type === "turn.completed")
          .map((event) => String(event.turnId)),
        [String(firstTurn.turnId)],
      );

      emit({
        id: "evt-copilot-second-turn-start",
        timestamp,
        parentId: null,
        type: "assistant.turn_start",
        data: {
          turnId: "sdk-turn-second",
        },
      } as SessionEvent);
      emit({
        id: "evt-copilot-second-message",
        timestamp,
        parentId: null,
        type: "assistant.message",
        data: {
          turnId: "sdk-turn-second",
          messageId: "message-second",
          content: "Second response.",
        },
      } as SessionEvent);
      emit({
        id: "evt-copilot-second-turn-end",
        timestamp,
        parentId: null,
        type: "assistant.turn_end",
        data: {
          turnId: "sdk-turn-second",
        },
      } as SessionEvent);
      emit({
        id: "evt-copilot-second-session-idle",
        timestamp,
        parentId: null,
        type: "session.idle",
        data: {
          aborted: false,
        },
      } as SessionEvent);
      yield* TestClock.adjust("300 millis");

      for (
        let attempt = 0;
        attempt < 20 && runtimeEvents.filter((event) => event.type === "turn.completed").length < 2;
        attempt += 1
      ) {
        yield* waitForSdkEventQueue();
      }
      yield* Fiber.interrupt(runtimeEventsFiber).pipe(Effect.ignore);

      const completedTurnIds = runtimeEvents
        .filter((event) => event.type === "turn.completed")
        .map((event) => String(event.turnId));
      NodeAssert.deepStrictEqual(completedTurnIds, [
        String(firstTurn.turnId),
        String(secondTurn.turnId),
      ]);

      const thread = yield* adapter.readThread(threadId);
      const firstSnapshot = thread.turns.find((entry) => entry.id === firstTurn.turnId);
      const secondSnapshot = thread.turns.find((entry) => entry.id === secondTurn.turnId);
      NodeAssert.ok(firstSnapshot);
      NodeAssert.ok(secondSnapshot);
      NodeAssert.deepStrictEqual(firstSnapshot.items, [
        {
          type: "assistant_message",
          messageId: "message-first",
          content: "First response.",
        },
      ]);
      NodeAssert.deepStrictEqual(secondSnapshot.items, [
        {
          type: "assistant_message",
          messageId: "message-second",
          content: "Second response.",
        },
      ]);

      const sessions = yield* adapter.listSessions();
      NodeAssert.equal(sessions.at(0)?.status, "ready");
      NodeAssert.equal(sessions.at(0)?.activeTurnId, undefined);

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

  it.effect("emits Copilot background task lifecycle events without plan updates", () =>
    Effect.gen(function* () {
      const adapter = yield* CopilotAdapter;
      const threadId = asThreadId("copilot-background-tasks-plan");

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

      runtimeMock.state.lastSession.rpc.tasks.list.mockResolvedValueOnce({
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

      for (
        let attempt = 0;
        attempt < 20 && runtimeEvents.filter((event) => event.type === "task.started").length < 3;
        attempt += 1
      ) {
        yield* waitForSdkEventQueue();
      }
      yield* Fiber.interrupt(runtimeEventsFiber).pipe(Effect.ignore);

      NodeAssert.equal(
        runtimeEvents.find((event) => event.type === "turn.plan.updated"),
        undefined,
      );
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

  it.effect("emits command metadata without unused reasoning or tool output deltas", () =>
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
        id: "evt-copilot-command-reasoning-1",
        timestamp,
        parentId: null,
        type: "assistant.reasoning_delta",
        data: {
          reasoningId: "reasoning-command",
          deltaContent: "Thinking through ",
        },
      } as SessionEvent);
      emit({
        id: "evt-copilot-command-reasoning-2",
        timestamp,
        parentId: null,
        type: "assistant.reasoning_delta",
        data: {
          reasoningId: "reasoning-command",
          deltaContent: "the command",
        },
      } as SessionEvent);
      emit({
        id: "evt-copilot-command-output-before-start",
        timestamp,
        parentId: null,
        type: "tool.execution_partial_result",
        data: {
          toolCallId: "tool-command",
          partialOutput: "On branch ",
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
      emit({
        id: "evt-copilot-command-output-after-start",
        timestamp,
        parentId: null,
        type: "tool.execution_partial_result",
        data: {
          toolCallId: "tool-command",
          partialOutput: "main",
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

      NodeAssert.equal(
        runtimeEvents.some((event) => event.type === "content.delta"),
        false,
      );

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("emits and terminally fails non-eligible Copilot quota errors", () =>
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
        id: "evt-copilot-session-error-message-delta",
        timestamp,
        parentId: null,
        ephemeral: true,
        type: "assistant.message_delta",
        data: {
          messageId: "message-session-error-partial",
          deltaContent: "Partial response before provider error.",
        },
      } as SessionEvent);
      config.onEvent({
        id: "evt-copilot-session-error-second-message-delta",
        timestamp,
        parentId: null,
        ephemeral: true,
        type: "assistant.message_delta",
        data: {
          messageId: "message-session-error-second-partial",
          deltaContent: "Second partial response before provider error.",
        },
      } as SessionEvent);
      config.onEvent({
        id: "evt-copilot-session-error",
        timestamp,
        parentId: null,
        type: "session.error",
        data: {
          errorType: "quota",
          errorCode: "quota_exceeded",
          message: "Copilot quota exceeded",
          eligibleForAutoSwitch: false,
          statusCode: 429,
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
      const rateLimitEvent = runtimeEvents.find(
        (event) => event.type === "account.rate-limits.updated",
      );
      NodeAssert.equal(rateLimitEvent?.type, "account.rate-limits.updated");
      if (rateLimitEvent?.type === "account.rate-limits.updated") {
        NodeAssert.deepStrictEqual(rateLimitEvent.payload.rateLimits, {
          errorType: "quota",
          errorCode: "quota_exceeded",
          message: "Copilot quota exceeded",
          eligibleForAutoSwitch: false,
          statusCode: 429,
        });
      }
      NodeAssert.equal(runtimeError?.type, "runtime.error");
      NodeAssert.equal(completed?.type, "turn.completed");
      if (completed?.type === "turn.completed") {
        NodeAssert.equal(completed.payload.state, "failed");
        NodeAssert.equal(completed.payload.errorMessage, "Copilot quota exceeded");
      }
      const assistantCompleted = runtimeEvents.filter(
        (event) =>
          event.type === "item.completed" &&
          (String(event.itemId) === "copilot-message-message-session-error-partial" ||
            String(event.itemId) === "copilot-message-message-session-error-second-partial"),
      );
      NodeAssert.equal(assistantCompleted.length, 2);
      for (const completedItem of assistantCompleted) {
        NodeAssert.equal(completedItem.type, "item.completed");
        if (completedItem.type === "item.completed") {
          NodeAssert.equal(completedItem.payload.status, "failed");
        }
      }
      const snapshot = (yield* adapter.readThread(threadId)).turns.find(
        (entry) => entry.id === turn.turnId,
      );
      NodeAssert.ok(snapshot);
      NodeAssert.deepStrictEqual(snapshot.items, [
        {
          type: "assistant_message",
          messageId: "message-session-error-partial",
          content: "Partial response before provider error.",
        },
        {
          type: "assistant_message",
          messageId: "message-session-error-second-partial",
          content: "Second partial response before provider error.",
        },
      ]);

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

  it.effect("keeps one T3 turn active across Copilot SDK loops until final output", () =>
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
        id: "evt-copilot-multi-loop-first-message",
        timestamp,
        parentId: null,
        type: "assistant.message",
        data: {
          messageId: "message-multi-loop-first",
          content: "First loop partial output.",
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
        id: "evt-copilot-multi-loop-idle-between-loops",
        timestamp,
        parentId: null,
        type: "session.idle",
        data: {
          aborted: false,
        },
      } as SessionEvent);

      yield* waitForSdkEventQueue();
      NodeAssert.equal(
        runtimeEvents.some((event) => event.type === "turn.completed"),
        false,
      );

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
      yield* TestClock.adjust("25 millis");

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

      emit({
        id: "evt-copilot-multi-loop-idle",
        timestamp,
        parentId: null,
        type: "session.idle",
        data: {
          aborted: false,
        },
      } as SessionEvent);

      yield* waitForSdkEventQueue();
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
      NodeAssert.deepStrictEqual(
        runtimeEvents
          .filter((event) => event.type === "turn.started")
          .map((event) => String(event.turnId)),
        [String(firstTurn.turnId)],
      );
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
      for (
        let attempt = 0;
        attempt < 20 &&
        !runtimeEvents.some(
          (event) =>
            event.type === "turn.started" && String(event.turnId) === String(secondTurn.turnId),
        );
        attempt += 1
      ) {
        yield* waitForSdkEventQueue();
      }
      NodeAssert.deepStrictEqual(
        runtimeEvents
          .filter((event) => event.type === "turn.started")
          .map((event) => String(event.turnId)),
        [String(firstTurn.turnId), String(secondTurn.turnId)],
      );
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

  it.effect("does not complete a successful tool turn when the assistant loop continues", () =>
    Effect.gen(function* () {
      const adapter = yield* CopilotAdapter;
      const threadId = asThreadId("copilot-successful-tool-continuation");

      yield* adapter.startSession({
        provider: COPILOT_DRIVER,
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });

      const turn = yield* adapter.sendTurn({
        threadId,
        input: "continue after a successful tool",
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
        id: "evt-copilot-tool-loop-start",
        timestamp,
        parentId: null,
        type: "assistant.turn_start",
        data: {
          turnId: "sdk-turn-tool-loop",
        },
      } as SessionEvent);
      emit({
        id: "evt-copilot-tool-loop-tool-start",
        timestamp,
        parentId: null,
        type: "tool.execution_start",
        data: {
          toolCallId: "tool-loop-success",
          toolName: "shell",
          turnId: "sdk-turn-tool-loop",
          arguments: {
            command: "true",
          },
        },
      } as SessionEvent);
      emit({
        id: "evt-copilot-tool-loop-tool-complete",
        timestamp,
        parentId: null,
        type: "tool.execution_complete",
        data: {
          toolCallId: "tool-loop-success",
          turnId: "sdk-turn-tool-loop",
          success: true,
          result: {
            content: "Command completed",
          },
        },
      } as SessionEvent);
      emit({
        id: "evt-copilot-tool-loop-transient-idle",
        timestamp,
        parentId: null,
        type: "session.idle",
        data: {
          aborted: false,
        },
      } as SessionEvent);
      yield* waitForSdkEventQueue();

      emit({
        id: "evt-copilot-tool-loop-continuation-start",
        timestamp,
        parentId: null,
        type: "assistant.turn_start",
        data: {
          turnId: "sdk-turn-tool-loop-continuation",
        },
      } as SessionEvent);
      yield* waitForSdkEventQueue();
      yield* TestClock.adjust("300 millis");

      emit({
        id: "evt-copilot-tool-loop-stale-idle",
        timestamp,
        parentId: null,
        type: "session.idle",
        data: {
          aborted: false,
        },
      } as SessionEvent);
      yield* waitForSdkEventQueue();

      NodeAssert.equal(
        runtimeEvents.some(
          (event) =>
            event.type === "turn.completed" && String(event.turnId) === String(turn.turnId),
        ),
        false,
      );

      emit({
        id: "evt-copilot-tool-loop-continuation-end",
        timestamp,
        parentId: null,
        type: "assistant.turn_end",
        data: {
          turnId: "sdk-turn-tool-loop-continuation",
        },
      } as SessionEvent);
      emit({
        id: "evt-copilot-tool-loop-final-idle",
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

      const completions = runtimeEvents.filter(
        (event) => event.type === "turn.completed" && String(event.turnId) === String(turn.turnId),
      );
      NodeAssert.equal(completions.length, 1);

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
      const coalescedStopFiber = yield* adapter.stopSession(threadId).pipe(Effect.forkChild);

      const replacementFiber = yield* adapter
        .startSession({
          provider: COPILOT_DRIVER,
          threadId,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
        })
        .pipe(Effect.forkChild);
      const secondReplacementFiber = yield* adapter
        .startSession({
          provider: COPILOT_DRIVER,
          threadId,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
        })
        .pipe(Effect.forkChild);
      yield* waitForSdkEventQueue();
      const sessionCreationsBeforeDrain = runtimeMock.state.createSessionConfigs.length;
      const disconnectsBeforeDrain = runtimeMock.state.lastSession.disconnect.mock.calls.length;
      releaseNativeWrite();
      yield* TestClock.adjust("25 millis");
      yield* Fiber.join(stopFiber);
      yield* Fiber.join(coalescedStopFiber);
      yield* Fiber.join(replacementFiber);
      yield* Fiber.join(secondReplacementFiber);

      for (
        let attempt = 0;
        attempt < 20 && !runtimeEvents.some((event) => event.type === "turn.completed");
        attempt += 1
      ) {
        yield* waitForSdkEventQueue();
      }
      yield* Fiber.interrupt(runtimeEventsFiber).pipe(Effect.ignore);

      NodeAssert.equal(runtimeMock.state.nativeWriteCalls > 0, true);
      NodeAssert.equal(sessionCreationsBeforeDrain, 1);
      NodeAssert.equal(disconnectsBeforeDrain, 0);
      NodeAssert.equal(runtimeMock.state.createSessionConfigs.length, 3);
      NodeAssert.equal(runtimeMock.state.lastSession.disconnect.mock.calls.length, 2);
      NodeAssert.equal(runtimeMock.state.startCalls, 3);
      NodeAssert.equal(runtimeMock.state.stopCalls, 2);
      NodeAssert.equal(yield* adapter.hasSession(threadId), true);

      const completed = runtimeEvents.find((event) => event.type === "turn.completed");
      NodeAssert.equal(completed?.type, "turn.completed");
      if (completed?.type === "turn.completed") {
        NodeAssert.equal(String(completed.turnId), String(turn.turnId));
        NodeAssert.equal(completed.payload.state, "interrupted");
      }

      yield* adapter.stopSession(threadId);
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

  it.effect("preserves the active turn when a queued Copilot send rejects", () =>
    Effect.gen(function* () {
      const adapter = yield* CopilotAdapter;
      const threadId = asThreadId("copilot-queued-send-failure-preserves-active-turn");

      yield* adapter.startSession({
        provider: COPILOT_DRIVER,
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });

      const activeTurn = yield* adapter.sendTurn({
        threadId,
        input: "keep this turn running",
        attachments: [],
      });

      runtimeMock.state.lastSession.send.mockRejectedValueOnce(new Error("Queued send rejected"));
      const queuedTurnResult = yield* adapter
        .sendTurn({
          threadId,
          input: "reject this queued turn",
          attachments: [],
        })
        .pipe(Effect.result);

      NodeAssert.equal(queuedTurnResult._tag, "Failure");
      const sessions = yield* adapter.listSessions();
      NodeAssert.equal(sessions.at(0)?.status, "running");
      NodeAssert.equal(String(sessions.at(0)?.activeTurnId), String(activeTurn.turnId));
      NodeAssert.equal(sessions.at(0)?.lastError, undefined);

      yield* adapter.stopSession(threadId);
    }),
  );
});
