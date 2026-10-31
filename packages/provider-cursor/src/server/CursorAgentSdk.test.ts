import type { LocalAgentStore } from "@cursor/sdk";
import * as NodePath from "@effect/platform-node/NodePath";
import { assert, describe, it } from "@effect/vitest";
import { ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";

import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as CursorAgentSdk from "./CursorAgentSdk.ts";
import * as CursorSdk from "./CursorSdk.ts";

const cursorSdkMock = vi.hoisted(() => {
  const closeExecutionOrder: Array<string> = [];
  const runOperations: Array<string> = [];
  let agentCloseFailure: unknown;
  let staleRunActive = false;
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
      runOperations.push("run.start");
      if (staleRunActive) {
        throw new Error("Agent agent-cursor-agent-sdk-test already has active run");
      }
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
  const create = vi.fn(async (_options: { readonly local?: { readonly store?: unknown } }) => ({
    agentId: "agent-cursor-agent-sdk-test",
    send,
    close: agentClose,
  }));
  const resume = vi.fn(
    async (_agentId: string, _options: { readonly local?: { readonly store?: unknown } }) => ({
      agentId: "agent-cursor-agent-sdk-test",
      send,
      close: agentClose,
    }),
  );
  const listRuns = vi.fn(async () => {
    runOperations.push("agent.listRuns");
    return {
      items: staleRunActive ? [{ id: "run-stale", status: "running" }] : [],
    };
  });
  const cancelRun = vi.fn(async () => {
    runOperations.push("agent.cancelRun");
    staleRunActive = false;
  });
  const listMessages = vi.fn(async (_agentId: string, _options: unknown) => []);
  const storeDispose = vi.fn(async () => {});
  const store = { dispose: storeDispose } as LocalAgentStore & { dispose: typeof storeDispose };
  const storeOpen = vi.fn(async (_options: unknown) => store);

  return {
    agentClose,
    cancelRun,
    closeExecutionOrder,
    create,
    listMessages,
    listRuns,
    resume,
    runOperations,
    runCancel,
    runWait,
    send,
    store,
    storeDispose,
    storeOpen,
    setAgentCloseFailure: (failure: unknown) => {
      agentCloseFailure = failure;
    },
    setStaleRunActive: (active: boolean) => {
      staleRunActive = active;
    },
  };
});

vi.mock("./sdk.ts", () => ({
  Agent: {
    create: cursorSdkMock.create,
    resume: cursorSdkMock.resume,
    listRuns: cursorSdkMock.listRuns,
    cancelRun: cursorSdkMock.cancelRun,
    messages: {
      list: cursorSdkMock.listMessages,
    },
  },
  createAgentPlatform: vi.fn(),
  getDefaultSdkStateRoot: () =>
    "C:\\Users\\dev\\.cursor\\projects\\C-work-repo\\sdk-agent-store\\0123abcd",
  SqliteLocalAgentStore: { open: cursorSdkMock.storeOpen },
}));

const layerRunner = CursorAgentSdk.layer.pipe(
  Layer.provide(
    Layer.succeed(ProviderEventLoggers.ProviderEventLoggers, {
      native: {
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
      },
      canonical: undefined,
    }),
  ),
  Layer.provide(CursorSdk.layer),
);

const layerOn = (platform: NodeJS.Platform) =>
  layerRunner.pipe(
    Layer.provide(platform === "win32" ? NodePath.layerWin32 : NodePath.layerPosix),
    Layer.provide(Layer.succeed(HostProcess.Platform, platform)),
  );

describe("CursorAgentSdkRunner", () => {
  it.effect("retries a resumed send after cancelling its abandoned local run", () =>
    Effect.gen(function* () {
      cursorSdkMock.runOperations.length = 0;
      cursorSdkMock.listRuns.mockClear();
      cursorSdkMock.cancelRun.mockClear();
      cursorSdkMock.setStaleRunActive(true);

      const runner = yield* CursorAgentSdk.CursorAgentSdkRunner;
      const session = yield* runner.open({
        operation: "resume",
        agentId: "agent-cursor-agent-sdk-test",
        options: { model: { id: "default" }, mode: "agent", local: { cwd: process.cwd() } },
        threadId: ThreadId.make("thread-cursor-agent-sdk-stale-run-test"),
        providerSessionId: ProviderSessionId.make(
          "provider-session-cursor-agent-sdk-stale-run-test",
        ),
      });
      assert.deepStrictEqual(cursorSdkMock.runOperations, []);
      const run = yield* session.send({ message: "continue" });
      yield* run.wait;

      assert.deepStrictEqual(cursorSdkMock.runOperations, [
        "run.start",
        "agent.listRuns",
        "agent.cancelRun",
        "run.start",
      ]);
      assert.deepStrictEqual(cursorSdkMock.listRuns.mock.calls[0], [
        "agent-cursor-agent-sdk-test",
        { runtime: "local", cwd: process.cwd(), limit: 1 },
      ]);
      assert.deepStrictEqual(cursorSdkMock.cancelRun.mock.calls[0], [
        "run-stale",
        {
          runtime: "local",
          cwd: process.cwd(),
        },
      ]);
    }).pipe(Effect.provide(layerOn("linux"))),
  );

  // regression: #19112 per-agent store.db paths past MAX_PATH never opened on Windows
  it.effect("shares one namespaced agent store per Windows workspace", () =>
    Effect.gen(function* () {
      cursorSdkMock.create.mockClear();
      cursorSdkMock.resume.mockClear();
      cursorSdkMock.listMessages.mockClear();
      cursorSdkMock.storeOpen.mockClear();
      cursorSdkMock.storeDispose.mockClear();
      const cwd = "C:\\work\\repo";

      yield* Effect.gen(function* () {
        const runner = yield* CursorAgentSdk.CursorAgentSdkRunner;
        for (const operation of ["create", "resume"] as const) {
          const session = yield* runner.open({
            operation,
            agentId: "agent-cursor-agent-sdk-test",
            options: {
              model: { id: "default" },
              mode: "agent",
              local: operation === "create" ? { cwd } : {},
            },
            threadId: ThreadId.make(`thread-cursor-agent-sdk-store-${operation}`),
            providerSessionId: ProviderSessionId.make(
              `provider-session-cursor-agent-sdk-store-${operation}`,
            ),
          });
          yield* session.listMessages;
          yield* session.close;
        }
        assert.strictEqual(cursorSdkMock.storeDispose.mock.calls.length, 0);
      }).pipe(
        Effect.provide(layerOn("win32")),
        Effect.provideService(HostProcess.WorkingDirectory, cwd),
      );

      assert.deepStrictEqual(cursorSdkMock.storeOpen.mock.calls, [
        [
          {
            workspaceRef: cwd,
            stateRoot: String.raw`\\?\C:\Users\dev\.cursor\projects\C-work-repo\sdk-agent-store\0123abcd`,
          },
        ],
      ]);
      assert.deepStrictEqual(
        cursorSdkMock.create.mock.calls.map(([options]) => options.local?.store),
        [cursorSdkMock.store],
      );
      assert.strictEqual(cursorSdkMock.resume.mock.calls[0]?.[1].local?.store, cursorSdkMock.store);
      assert.deepStrictEqual(
        cursorSdkMock.listMessages.mock.calls.map(([, options]) => options),
        [
          { runtime: "local", cwd, store: cursorSdkMock.store },
          { runtime: "local", store: cursorSdkMock.store },
        ],
      );
      assert.strictEqual(cursorSdkMock.storeDispose.mock.calls.length, 1);
    }),
  );

  it.effect("preserves caller stores and leaves non-Windows defaults to the SDK", () =>
    Effect.gen(function* () {
      for (const platform of ["win32", "linux", "darwin"] as const) {
        for (const store of [cursorSdkMock.store, undefined]) {
          if (platform === "win32" && store === undefined) continue;
          cursorSdkMock.storeOpen.mockClear();
          cursorSdkMock.storeDispose.mockClear();
          cursorSdkMock.listMessages.mockClear();
          const options = {
            model: { id: "default" },
            mode: "agent" as const,
            local: { cwd: "workspace", ...(store === undefined ? {} : { store }) },
          };
          yield* Effect.gen(function* () {
            const runner = yield* CursorAgentSdk.CursorAgentSdkRunner;
            const session = yield* runner.open({
              operation: "create",
              options,
              threadId: ThreadId.make("thread-cursor-store-override"),
              providerSessionId: ProviderSessionId.make("session-cursor-store-override"),
            });
            yield* session.listMessages;
            yield* session.close;
          }).pipe(Effect.provide(layerOn(platform)));
          assert.strictEqual(cursorSdkMock.create.mock.lastCall?.[0], options);
          assert.deepStrictEqual(cursorSdkMock.listMessages.mock.lastCall?.[1], {
            runtime: "local",
            cwd: "workspace",
            ...(store === undefined ? {} : { store }),
          });
          assert.strictEqual(cursorSdkMock.storeOpen.mock.calls.length, 0);
          assert.strictEqual(cursorSdkMock.storeDispose.mock.calls.length, 0);
        }
      }
    }),
  );
});
