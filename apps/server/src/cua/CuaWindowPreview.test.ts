import { it } from "@effect/vitest";
import {
  EventId,
  ProviderDriverKind,
  type ProviderRuntimeEvent,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";

import * as McpProviderSession from "../mcp/McpProviderSession.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import * as CuaWindowPreview from "./CuaWindowPreview.ts";
import { cuaToolPresentation } from "./cuaToolPresentation.ts";

const threadId = ThreadId.make("11111111-2222-4333-8444-555555555555");
const png = "iVBORw0KGgo=";

const turnEvent = (type: "turn.started" | "turn.completed"): ProviderRuntimeEvent =>
  ({
    type,
    eventId: EventId.make(`${type}-1`),
    provider: ProviderDriverKind.make("codex"),
    threadId,
    turnId: TurnId.make("turn-1"),
    createdAt: "2026-09-14T00:00:00.000Z",
  }) as ProviderRuntimeEvent;

const makeHarness = Effect.fn(function* () {
  const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  const captures: string[] = [];
  let clients = 0;
  let destroyed = 0;
  const fakeClient = {
    getWindowState: (input: { pid: number; windowId: bigint }) =>
      Promise.resolve({
        pid: input.pid,
        windowId: input.windowId,
        appName: "Calendar",
        windowTitle: "December 2026",
        screenshotWidth: 640,
        screenshotHeight: 400,
        images: [{ mimeType: "image/png", dataBase64: png }],
      }),
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
    Effect.provideService(ProviderService, {
      streamEvents: Stream.fromPubSub(events),
    } as unknown as ProviderService["Service"]),
  );
  return {
    service,
    emit: (event: ProviderRuntimeEvent) => PubSub.publish(events, event),
    captures,
    counts: () => ({ clients, destroyed }),
  };
});

const layer = NodeServices.layer;

describe("CuaWindowPreview", () => {
  it.live("captures only while a client subscribes during a Cua turn", () =>
    Effect.gen(function* () {
      McpProviderSession.setMcpProviderSession({
        threadId,
        endpoint: "http://127.0.0.1/mcp",
        authorizationHeader: "Bearer x",
        capabilities: new Set(),
        cuaDriver: { command: "/driver", args: [], environment: [], socketPath: "/tmp/cua.sock" },
      } as unknown as McpProviderSession.McpProviderSessionConfig);
      const harness = yield* makeHarness();
      const live = yield* Deferred.make<void>();
      const idle = yield* Deferred.make<void>();
      const states: string[] = [];
      const subscriber = yield* harness.service.stream(threadId).pipe(
        Stream.tap((state) =>
          Effect.gen(function* () {
            states.push(state.status);
            if (state.status === "live") yield* Deferred.succeed(live, undefined);
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
      expect(harness.captures.length).toBeGreaterThan(0);

      yield* harness.emit(turnEvent("turn.completed"));
      yield* Deferred.await(idle);
      expect(harness.counts().destroyed).toBe(1);
      const capturesAtIdle = harness.captures.length;
      yield* Effect.sleep(Duration.millis(60));
      expect(harness.captures.length).toBe(capturesAtIdle);
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
});
