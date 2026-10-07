import { it } from "@effect/vitest";
import type { OrchestrationV2DomainEvent } from "@t3tools/contracts";
import { ThreadId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect } from "vite-plus/test";

import * as McpProviderSession from "../mcp/McpProviderSession.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as CuaWindowPreview from "./CuaWindowPreview.ts";
import { clearCuaToolContext, cuaToolPresentation } from "./cuaToolPresentation.ts";

const threadId = ThreadId.make("11111111-2222-4333-8444-555555555555");
const png = "iVBORw0KGgo=";

const turnEvent = (type: "turn.started" | "turn.completed") =>
  ({
    type: "provider-turn.updated",
    threadId,
    payload: { status: type === "turn.started" ? "running" : "completed" },
  }) as unknown as OrchestrationV2DomainEvent;

const makeHarness = Effect.fn(function* (
  windowFailure?: "missing" | "throw" | "transient",
  onWindowCapture?: () => void | Promise<void>,
) {
  const events = yield* PubSub.unbounded<OrchestrationV2DomainEvent>();
  const captures: string[] = [];
  const windows: Array<{ pid: number; windowId: bigint }> = [];
  let clients = 0;
  let destroyed = 0;
  const fakeClient = {
    getWindowState: async (input: { pid: number; windowId: bigint }) => {
      windows.push(input);
      await onWindowCapture?.();
      if (windowFailure === "throw" || (windowFailure === "transient" && windows.length < 3))
        return Promise.reject(new Error("Window capture interrupted"));
      return Promise.resolve({
        pid: input.pid,
        windowId: input.windowId,
        appName: "Calendar",
        windowTitle: "December 2026",
        screenshotWidth: 640,
        screenshotHeight: 400,
        images: windowFailure === "missing" ? [] : [{ mimeType: "image/png", dataBase64: png }],
      });
    },
    getDesktopState: () => {
      captures.push("desktop");
      return Promise.resolve({
        text: "",
        images: [{ mimeType: "image/png", dataBase64: png }],
        isError: false,
        degraded: false,
        rawJson: "{}",
      });
    },
    shutdown: () => Promise.resolve(),
    uniffiDestroy: () => {
      destroyed += 1;
    },
  };
  const sdk = {
    CuaDriver: {
      connect: () => {
        clients += 1;
        return fakeClient;
      },
    },
    GetWindowStateInput: { new: (input: unknown) => input },
    GetDesktopStateInput: { new: (input: unknown) => input },
  } as unknown as CuaWindowPreview.SdkModule;
  const service = yield* CuaWindowPreview.make({
    loadSdk: Effect.succeed(sdk),
    refreshInterval: Duration.millis(20),
  }).pipe(
    Effect.provideService(Orchestrator.OrchestratorV2, {
      streamDomainEvents: Stream.fromPubSub(events),
    } as unknown as Orchestrator.OrchestratorV2["Service"]),
  );
  return {
    service,
    emit: (event: OrchestrationV2DomainEvent) => PubSub.publish(events, event),
    captures,
    windows,
    counts: () => ({ clients, destroyed }),
  };
});

const layer = NodeServices.layer;

describe("CuaWindowPreview", () => {
  it.effect("never overlaps captures and backs off after a slow frame", () =>
    Effect.gen(function* () {
      clearCuaToolContext(threadId);
      McpProviderSession.setMcpProviderSession({
        threadId,
        endpoint: "http://127.0.0.1/mcp",
        authorizationHeader: "Bearer x",
        capabilities: new Set(),
        cuaDriver: { command: "/driver", args: [], environment: [], socketPath: "/tmp/cua.sock" },
      } as unknown as McpProviderSession.McpProviderSessionConfig);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          McpProviderSession.clearMcpProviderSession(threadId);
          clearCuaToolContext(threadId);
        }),
      );
      cuaToolPresentation({
        threadId,
        rawToolName: "cua-driver/get_window_state",
        args: { pid: 42, window_id: 7 },
        status: "completed",
      });
      const gate = Promise.withResolvers<void>();
      const firstStarted = yield* Deferred.make<void>();
      const secondStarted = yield* Deferred.make<void>();
      const firstPublished = yield* Deferred.make<void>();
      let calls = 0;
      const harness = yield* makeHarness(undefined, () => {
        calls += 1;
        Deferred.doneUnsafe(calls === 1 ? firstStarted : secondStarted, Effect.void);
        return calls === 1 ? gate.promise : undefined;
      });
      yield* harness.service.stream(threadId).pipe(
        Stream.runForEach((state) =>
          state.frame ? Deferred.succeed(firstPublished, undefined) : Effect.void,
        ),
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;
      yield* harness.emit(turnEvent("turn.started"));
      yield* Deferred.await(firstStarted);
      yield* TestClock.adjust(40);
      expect(calls).toBe(1);
      gate.resolve();
      yield* Deferred.await(firstPublished);
      yield* TestClock.adjust(39);
      expect(calls).toBe(1);
      yield* TestClock.adjust(1);
      yield* Deferred.await(secondStarted);
      expect(calls).toBe(2);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("stops capture at turn end and waits for a fresh window in the next turn", () =>
    Effect.gen(function* () {
      McpProviderSession.setMcpProviderSession({
        threadId,
        endpoint: "http://127.0.0.1/mcp",
        authorizationHeader: "Bearer x",
        capabilities: new Set(),
        cuaDriver: { command: "/driver", args: [], environment: [], socketPath: "/tmp/cua.sock" },
      } as unknown as McpProviderSession.McpProviderSessionConfig);
      clearCuaToolContext(threadId);
      cuaToolPresentation({
        threadId,
        rawToolName: "cua-driver/get_window_state",
        args: { pid: 42, window_id: 7 },
        status: "completed",
      });
      const harness = yield* makeHarness();
      const waiting = yield* Deferred.make<void>();
      const resumed = yield* Deferred.make<void>();
      const live = yield* Deferred.make<void>();
      const idle = yield* Deferred.make<void>();
      const states: string[] = [];
      const subscriber = yield* harness.service.stream(threadId).pipe(
        Stream.tap((state) =>
          Effect.gen(function* () {
            states.push(state.status);
            if (state.status === "live" && state.frame) {
              yield* Deferred.succeed(live, undefined);
              if (harness.windows.at(-1)?.windowId === 8n)
                yield* Deferred.succeed(resumed, undefined);
            }
            if (state.status === "live" && !state.frame)
              yield* Deferred.succeed(waiting, undefined);
            if (state.status === "idle" && states.length > 1)
              yield* Deferred.succeed(idle, undefined);
          }),
        ),
        Stream.runDrain,
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;
      expect(states).toEqual(["idle"]);
      expect(harness.counts().clients).toBe(0);

      yield* harness.emit(turnEvent("turn.started"));
      yield* Deferred.await(live);
      expect(harness.counts().clients).toBe(1);
      expect(harness.windows.length).toBeGreaterThan(0);

      yield* harness.emit(turnEvent("turn.completed"));
      yield* Deferred.await(idle);
      expect(harness.counts().destroyed).toBe(1);
      const capturesAtIdle = harness.windows.length;
      yield* harness.emit(turnEvent("turn.started"));
      yield* Deferred.await(waiting);
      expect(harness.windows.length).toBe(capturesAtIdle);
      expect(harness.captures).toEqual([]);
      cuaToolPresentation({
        threadId,
        rawToolName: "cua-driver/get_window_state",
        args: { pid: 43, window_id: 8 },
        status: "completed",
      });
      yield* Deferred.await(resumed);
      expect(harness.windows.at(-1)).toMatchObject({ pid: 43, windowId: 8n });
      expect(states).not.toContain("unavailable");
      yield* Fiber.interrupt(subscriber);
      McpProviderSession.clearMcpProviderSession(threadId);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("prefers the window the agent last targeted", () =>
    Effect.gen(function* () {
      McpProviderSession.setMcpProviderSession({
        threadId,
        endpoint: "http://127.0.0.1/mcp",
        authorizationHeader: "Bearer x",
        capabilities: new Set(),
        cuaDriver: { command: "/driver", args: [], environment: [], socketPath: "/tmp/cua.sock" },
      } as unknown as McpProviderSession.McpProviderSessionConfig);
      cuaToolPresentation({
        threadId,
        rawToolName: "cua-driver/click",
        args: { pid: 42, window_id: "7", x: 1, y: 1 },
        status: "completed",
      });
      const harness = yield* makeHarness();
      const first = yield* harness.service.stream(threadId).pipe(
        Stream.filter((state) => state.status === "live"),
        Stream.runHead,
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;
      yield* harness.emit(turnEvent("turn.started"));
      const state = yield* Fiber.join(first);
      expect(state._tag).toBe("Some");
      if (state._tag !== "Some") return;
      expect(state.value.frame).toMatchObject({
        appName: "Calendar",
        windowTitle: "December 2026",
        width: 640,
        height: 400,
        mimeType: "image/png",
      });
      expect(harness.captures).toEqual([]);
      McpProviderSession.clearMcpProviderSession(threadId);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("stays idle for sessions without a managed driver socket", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.emit(turnEvent("turn.started"));
      const state = yield* harness.service.stream(threadId).pipe(Stream.runHead);
      expect(state._tag === "Some" ? state.value : null).toEqual({ status: "idle" });
      yield* Effect.sleep(Duration.millis(40));
      expect(harness.counts().clients).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("follows window selection and switching after capture has started", () =>
    Effect.gen(function* () {
      clearCuaToolContext(threadId);
      McpProviderSession.setMcpProviderSession({
        threadId,
        endpoint: "http://127.0.0.1/mcp",
        authorizationHeader: "Bearer x",
        capabilities: new Set(),
        cuaDriver: { command: "/driver", args: [], environment: [], socketPath: "/tmp/cua.sock" },
      } as unknown as McpProviderSession.McpProviderSessionConfig);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          McpProviderSession.clearMcpProviderSession(threadId);
          clearCuaToolContext(threadId);
        }),
      );
      const harness = yield* makeHarness();
      const waiting = yield* Deferred.make<void>();
      const firstWindow = yield* Deferred.make<void>();
      const secondWindow = yield* Deferred.make<void>();
      yield* harness.service.stream(threadId).pipe(
        Stream.runForEach((state) =>
          Effect.gen(function* () {
            if (state.status !== "live") return;
            const window = harness.windows.at(-1);
            if (!window) yield* Deferred.succeed(waiting, undefined);
            else if (window.windowId === 7n) yield* Deferred.succeed(firstWindow, undefined);
            else if (window.windowId === 8n) yield* Deferred.succeed(secondWindow, undefined);
          }),
        ),
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;
      yield* harness.emit(turnEvent("turn.started"));
      yield* Deferred.await(waiting);
      expect(harness.captures).toEqual([]);
      cuaToolPresentation({
        threadId,
        rawToolName: "cua-driver/get_window_state",
        args: { pid: 42, window_id: 7 },
        status: "completed",
      });
      yield* Deferred.await(firstWindow);
      cuaToolPresentation({
        threadId,
        rawToolName: "cua-driver/get_window_state",
        args: { pid: 43, window_id: 8 },
        status: "completed",
      });
      yield* Deferred.await(secondWindow);
      expect(harness.windows.at(-1)).toMatchObject({ pid: 43, windowId: 8n });
      expect(harness.counts().clients).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("discards a completed capture after the agent switches windows", () =>
    Effect.gen(function* () {
      McpProviderSession.setMcpProviderSession({
        threadId,
        endpoint: "http://127.0.0.1/mcp",
        authorizationHeader: "Bearer x",
        capabilities: new Set(),
        cuaDriver: { command: "/driver", args: [], environment: [], socketPath: "/tmp/cua.sock" },
      } as unknown as McpProviderSession.McpProviderSessionConfig);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          McpProviderSession.clearMcpProviderSession(threadId);
          clearCuaToolContext(threadId);
        }),
      );
      const selectWindow = (windowId: number) =>
        cuaToolPresentation({
          threadId,
          rawToolName: "cua-driver/get_window_state",
          args: { pid: 42, window_id: windowId },
          status: "completed",
        });
      selectWindow(7);
      const harness = yield* makeHarness(undefined, () => {
        selectWindow(8);
      });
      const first = yield* harness.service.stream(threadId).pipe(
        Stream.filter((state) => state.status !== "idle"),
        Stream.runHead,
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;
      yield* harness.emit(turnEvent("turn.started"));
      const state = yield* Fiber.join(first);
      expect(state._tag === "Some" ? state.value.status : null).toBe("live");
      expect(harness.windows.map((window) => window.windowId)).toEqual([7n, 8n]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("retries transient capture failures without publishing unavailable", () =>
    Effect.gen(function* () {
      McpProviderSession.setMcpProviderSession({
        threadId,
        endpoint: "http://127.0.0.1/mcp",
        authorizationHeader: "Bearer x",
        capabilities: new Set(),
        cuaDriver: { command: "/driver", args: [], environment: [], socketPath: "/tmp/cua.sock" },
      } as unknown as McpProviderSession.McpProviderSessionConfig);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          McpProviderSession.clearMcpProviderSession(threadId);
          clearCuaToolContext(threadId);
        }),
      );
      cuaToolPresentation({
        threadId,
        rawToolName: "cua-driver/get_window_state",
        args: { pid: 42, window_id: 7 },
        status: "completed",
      });
      const harness = yield* makeHarness("transient");
      const first = yield* harness.service.stream(threadId).pipe(
        Stream.filter((state) => state.status !== "idle"),
        Stream.runHead,
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;
      yield* harness.emit(turnEvent("turn.started"));
      const state = yield* Fiber.join(first);
      expect(state._tag === "Some" ? state.value.status : null).toBe("live");
      expect(harness.windows).toHaveLength(3);
      expect(harness.captures).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live.each(["missing", "throw"] as const)(
    "does not substitute desktop pixels when window capture is %s",
    (failure) =>
      Effect.gen(function* () {
        McpProviderSession.setMcpProviderSession({
          threadId,
          endpoint: "http://127.0.0.1/mcp",
          authorizationHeader: "Bearer x",
          capabilities: new Set(),
          cuaDriver: { command: "/driver", args: [], environment: [], socketPath: "/tmp/cua.sock" },
        } as unknown as McpProviderSession.McpProviderSessionConfig);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => McpProviderSession.clearMcpProviderSession(threadId)),
        );
        cuaToolPresentation({
          threadId,
          rawToolName: "cua-driver/click",
          args: { pid: 42, window_id: "7", x: 1, y: 1 },
          status: "completed",
        });
        const harness = yield* makeHarness(failure);
        const unavailable = yield* harness.service.stream(threadId).pipe(
          Stream.filter((state) => state.status !== "idle"),
          Stream.runHead,
          Effect.forkScoped,
        );
        yield* Effect.yieldNow;
        yield* harness.emit(turnEvent("turn.started"));
        const state = yield* Fiber.join(unavailable);
        expect(state._tag === "Some" ? state.value.status : null).toBe("unavailable");
        expect(state._tag === "Some" ? state.value.frame : null).toBeUndefined();
        expect(harness.captures).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});
