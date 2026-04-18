import assert from "node:assert/strict";

import * as NodeServices from "@effect/platform-node/NodeServices";
import type {
  CopilotClient,
  CopilotSession,
  PermissionRequest,
  SessionConfig,
} from "@github/copilot-sdk";
import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { beforeEach, vi } from "vitest";

import { ThreadId } from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { CopilotAdapter } from "../Services/CopilotAdapter.ts";
import { makeCopilotAdapterLive } from "./CopilotAdapter.ts";

const asThreadId = (value: string): ThreadId => ThreadId.make(value);

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
          provider: "copilot",
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
          provider: "copilot",
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
          provider: "copilot",
          threadId,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
        });

        assert.equal(session.provider, "copilot");
        yield* adapter.stopSession(threadId);
      }),
  );
});
