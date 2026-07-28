import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";

import { ServerConfig } from "../../config.ts";
import {
  CursorAgentSdkRunner,
  CursorAgentSdkRunnerError,
  cursorAgentSdkRunnerLiveLayer,
} from "./CursorAgentSdk.ts";

const cursorSdkMock = vi.hoisted(() => {
  const closeExecutionOrder: Array<string> = [];
  let agentCloseFailure: unknown;
  const runWait = vi.fn(async () => ({
    id: "run-cursor-agent-sdk-test",
    requestId: "request-cursor-agent-sdk-test",
    status: "finished",
    result: "ok",
    model: { id: "default" },
    durationMs: 1,
  }));
  const runCancel = vi.fn(async () => {});
  const agentClose = vi.fn(() => {
    closeExecutionOrder.push("sdk:agent.close");
    if (agentCloseFailure !== undefined) {
      throw agentCloseFailure;
    }
  });
  const send = vi.fn(
    async (
      _message: unknown,
      options: { readonly onDelta?: (input: { readonly update: unknown }) => Promise<void> },
    ) => {
      await options.onDelta?.({
        update: {
          type: "assistant-message-chunk",
          text: "hello",
        },
      });
      return {
        id: "run-cursor-agent-sdk-test",
        agentId: "agent-cursor-agent-sdk-test",
        wait: runWait,
        cancel: runCancel,
      };
    },
  );
  const create = vi.fn(async () => ({
    agentId: "agent-cursor-agent-sdk-test",
    send,
    close: agentClose,
  }));

  return {
    agentClose,
    closeExecutionOrder,
    create,
    runCancel,
    runWait,
    send,
    setAgentCloseFailure: (failure: unknown) => {
      agentCloseFailure = failure;
    },
  };
});

vi.mock("../../provider/Layers/EventNdjsonLogger.ts", async () => {
  const Effect = await import("effect/Effect");

  return {
    makeEventNdjsonLogger: vi.fn(() =>
      Effect.succeed({
        filePath: "cursor-agent-sdk-test.log",
        write: (event: unknown) =>
          Effect.sync(() => {
            if (
              typeof event === "object" &&
              event !== null &&
              Reflect.get(Reflect.get(event, "event"), "payload")?.type === "agent.close"
            ) {
              cursorSdkMock.closeExecutionOrder.push("protocol:agent.close");
            }
          }),
        close: () => Effect.void,
      }),
    ),
  };
});

vi.mock("@cursor/sdk", () => ({
  Agent: {
    create: cursorSdkMock.create,
    resume: vi.fn(),
    messages: {
      list: vi.fn(async () => []),
    },
  },
}));

const testLayer = cursorAgentSdkRunnerLiveLayer.pipe(
  Layer.provide(
    ServerConfig.layerTest(process.cwd(), {
      prefix: "t3-cursor-agent-sdk-runner-",
    }),
  ),
  Layer.provide(NodeServices.layer),
);

describe("CursorAgentSdkRunner", () => {
  it.effect("logs agent.close before invoking the Cursor SDK", () =>
    Effect.gen(function* () {
      cursorSdkMock.agentClose.mockClear();
      cursorSdkMock.closeExecutionOrder.length = 0;
      cursorSdkMock.setAgentCloseFailure(undefined);

      const runner = yield* CursorAgentSdkRunner;
      const session = yield* runner.open({
        operation: "create",
        options: {
          model: { id: "default" },
          mode: "agent",
          local: {
            cwd: process.cwd(),
          },
        },
        threadId: ThreadId.make("thread-cursor-agent-sdk-close-order-test"),
        providerSessionId: ProviderSessionId.make(
          "provider-session-cursor-agent-sdk-close-order-test",
        ),
      });

      cursorSdkMock.closeExecutionOrder.length = 0;
      yield* session.close;

      assert.deepStrictEqual(cursorSdkMock.closeExecutionOrder, [
        "protocol:agent.close",
        "sdk:agent.close",
      ]);
      assert.equal(cursorSdkMock.agentClose.mock.calls.length, 1);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("logs agent.close even when the Cursor SDK close fails", () =>
    Effect.gen(function* () {
      cursorSdkMock.agentClose.mockClear();
      cursorSdkMock.closeExecutionOrder.length = 0;
      const closeFailure = new Error("agent close failed");
      cursorSdkMock.setAgentCloseFailure(closeFailure);

      const runner = yield* CursorAgentSdkRunner;
      const session = yield* runner.open({
        operation: "create",
        options: {
          model: { id: "default" },
          mode: "agent",
          local: {
            cwd: process.cwd(),
          },
        },
        threadId: ThreadId.make("thread-cursor-agent-sdk-close-failure-test"),
        providerSessionId: ProviderSessionId.make(
          "provider-session-cursor-agent-sdk-close-failure-test",
        ),
      });

      cursorSdkMock.closeExecutionOrder.length = 0;
      const error = yield* Effect.flip(session.close);

      assert.instanceOf(error, CursorAgentSdkRunnerError);
      assert.equal(error.method, "agent.close");
      assert.strictEqual(error.cause, closeFailure);
      assert.deepStrictEqual(cursorSdkMock.closeExecutionOrder, [
        "protocol:agent.close",
        "sdk:agent.close",
      ]);
      assert.equal(cursorSdkMock.agentClose.mock.calls.length, 1);
      cursorSdkMock.setAgentCloseFailure(undefined);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("surfaces interaction callback failures through run.wait", () =>
    Effect.gen(function* () {
      cursorSdkMock.create.mockClear();
      cursorSdkMock.runWait.mockClear();
      cursorSdkMock.send.mockClear();

      const runner = yield* CursorAgentSdkRunner;
      const session = yield* runner.open({
        operation: "create",
        options: {
          model: { id: "default" },
          mode: "agent",
          local: {
            cwd: process.cwd(),
            autoReview: false,
            sandboxOptions: { enabled: false },
            enableAgentRetries: true,
          },
        },
        threadId: ThreadId.make("thread-cursor-agent-sdk-test"),
        providerSessionId: ProviderSessionId.make("provider-session-cursor-agent-sdk-test"),
      });

      const callbackFailure = new Error("delta callback failed");
      const run = yield* session.send({
        message: "hello",
        onDelta: () => Effect.fail(callbackFailure),
      });

      const error = yield* Effect.flip(run.wait);

      assert.instanceOf(error, CursorAgentSdkRunnerError);
      assert.equal(error.method, "run.wait");
      assert.strictEqual(error.cause, callbackFailure);
      assert.equal(cursorSdkMock.create.mock.calls.length, 1);
      assert.equal(cursorSdkMock.send.mock.calls.length, 1);
      assert.equal(cursorSdkMock.runWait.mock.calls.length, 1);
    }).pipe(Effect.provide(testLayer)),
  );
});
