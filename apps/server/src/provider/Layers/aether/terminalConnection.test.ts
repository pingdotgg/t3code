import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import { taskProcessing } from "./eventMapper.fixtures.ts";
import type { AetherRestClient } from "./restClient.ts";
import type { AetherWorkspaceConnectOutcome } from "./restSchemas.ts";
import { openAetherTerminalConnection, parseTerminalServerFrame } from "./terminalConnection.ts";
import type { AetherWebSocketLike } from "./workspaceSocket.ts";

describe("parseTerminalServerFrame", () => {
  it("parses an output frame on the terminal channel", () => {
    expect(
      parseTerminalServerFrame(
        JSON.stringify({ channel: "terminal", type: "output", sessionId: "term-1", data: "hello" }),
      ),
    ).toEqual({ _tag: "output", sessionId: "term-1", data: "hello" });
  });

  it("parses a close frame", () => {
    expect(
      parseTerminalServerFrame(
        JSON.stringify({ channel: "terminal", type: "close", sessionId: "term-1" }),
      ),
    ).toEqual({ _tag: "close", sessionId: "term-1" });
  });

  it("ignores frames on other channels", () => {
    expect(
      parseTerminalServerFrame(
        JSON.stringify({ channel: "ports", type: "snapshot", ports: [3000] }),
      ),
    ).toEqual({ _tag: "ignored" });
  });

  it("ignores a terminal output frame missing its data (never drops silently as output)", () => {
    expect(
      parseTerminalServerFrame(
        JSON.stringify({ channel: "terminal", type: "output", sessionId: "x" }),
      ),
    ).toEqual({ _tag: "ignored" });
  });

  it("ignores non-JSON and non-object payloads", () => {
    expect(parseTerminalServerFrame("not json")).toEqual({ _tag: "ignored" });
    expect(parseTerminalServerFrame("null")).toEqual({ _tag: "ignored" });
    expect(parseTerminalServerFrame("42")).toEqual({ _tag: "ignored" });
  });
});

// ---------------------------------------------------------------------------
// Reconnection harness (mirrors workspaceSocket.test.ts FakeSocket)
// ---------------------------------------------------------------------------

type WsListener = (event: never) => void;

class FakeSocket implements AetherWebSocketLike {
  readonly sent: Array<string> = [];
  private opened = false;
  private closed = false;
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();

  addEventListener(type: string, listener: WsListener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener as (event: unknown) => void);
    this.listeners.set(type, list);
    // Model an already-open upgrade: the loop registers its open listener after
    // the factory calls open(), so fire on registration.
    if (type === "open" && this.opened) (listener as () => void)();
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.fire("close", { code: 1000, reason: "client closed" });
  }

  open(): void {
    this.opened = true;
    this.fire("open", undefined);
  }

  serverClose(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.fire("close", { code, reason });
  }

  message(frame: unknown): void {
    this.fire("message", { data: JSON.stringify(frame) });
  }

  private fire(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const ZERO_TIMING = {
  pollInitialMs: 0,
  pollMaxMs: 0,
  reconnectInitialMs: 0,
  reconnectMaxMs: 0,
  connectDefaultRetryMs: 0,
} as const;

const runningOutcome: AetherWorkspaceConnectOutcome = {
  state: "running",
  transport: { websocket_path: "/workspaces/ws-1/ws", preview_token: "t".repeat(32) },
};

const restClient: Pick<AetherRestClient, "getTask" | "connectWorkspace"> = {
  getTask: () => Effect.succeed(taskProcessing),
  connectWorkspace: () => Effect.succeed(runningOutcome),
};

// Drive the forked loop/pump through queued signals and the zero-duration
// backoff sleeps.
const settle = Effect.gen(function* () {
  for (let i = 0; i < 8; i++) {
    yield* TestClock.adjust("0 millis");
    yield* Effect.yieldNow;
  }
});

const openHarness = (input: {
  readonly sockets: Array<FakeSocket>;
  readonly onOutput: (data: string) => void;
  readonly onClosed: (reason: string) => void;
  readonly cols: number;
  readonly rows: number;
}) =>
  openAetherTerminalConnection({
    restClient,
    apiBaseUrl: "https://api.runaether.dev",
    apiKey: "aether_test_key",
    taskId: "task-1",
    sessionId: "term-1",
    cols: input.cols,
    rows: input.rows,
    timing: ZERO_TIMING,
    webSocketFactory: () => {
      const socket = new FakeSocket();
      input.sockets.push(socket);
      socket.open();
      return socket;
    },
    onOutput: input.onOutput,
    onClosed: input.onClosed,
  });

describe("openAetherTerminalConnection", () => {
  it.effect("returns a handle and applies the requested size on first attach", () =>
    Effect.gen(function* () {
      const sockets: Array<FakeSocket> = [];
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* openHarness({
            sockets,
            onOutput: () => {},
            onClosed: () => {},
            cols: 120,
            rows: 30,
          });
          yield* settle;
          expect(sockets.length).toBe(1);
          expect(sockets[0]!.sent.some((s) => s.includes('"create"'))).toBe(true);
          expect(
            sockets[0]!.sent.some(
              (s) => s.includes('"resize"') && s.includes("120") && s.includes("30"),
            ),
          ).toBe(true);
        }),
      );
    }),
  );

  it.effect("reconnects a fresh shell on a socket drop, and stops on shell exit", () =>
    Effect.gen(function* () {
      const sockets: Array<FakeSocket> = [];
      const outputs: Array<string> = [];
      const closes: Array<string> = [];
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* openHarness({
            sockets,
            onOutput: (d) => outputs.push(d),
            onClosed: (r) => closes.push(r),
            cols: 80,
            rows: 24,
          });
          yield* settle;
          expect(sockets.length).toBe(1);

          // Transient socket drop → transparent reconnect (a fresh socket).
          sockets[0]!.serverClose(1006, "network blip");
          yield* settle;
          expect(sockets.length).toBe(2);
          expect(outputs.some((o) => o.includes("reconnecting"))).toBe(true);
          expect(closes).toHaveLength(0);

          // The fresh shell produces output, then exits → connection ends, no reconnect.
          sockets[1]!.message({
            channel: "terminal",
            type: "output",
            sessionId: "term-1",
            data: "hi",
          });
          sockets[1]!.message({ channel: "terminal", type: "close", sessionId: "term-1" });
          yield* settle;
          expect(outputs).toContain("hi");
          expect(closes).toContain("shell exited");
          expect(sockets.length).toBe(2);
        }),
      );
    }),
  );

  it.effect("recreates the PTY at the resized dimensions after a drop", () =>
    Effect.gen(function* () {
      const sockets: Array<FakeSocket> = [];
      yield* Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* openHarness({
            sockets,
            onOutput: () => {},
            onClosed: () => {},
            cols: 80,
            rows: 24,
          });
          yield* settle;
          // User resizes; the connector records the new size and forwards it.
          yield* connection.resize(200, 50);
          yield* settle;
          expect(
            sockets[0]!.sent.some((s) => s.includes('"cols":200') && s.includes('"rows":50')),
          ).toBe(true);

          // A drop recreates the PTY at 200x50 — not the stale initial 80x24.
          sockets[0]!.serverClose(1006, "blip");
          yield* settle;
          expect(sockets.length).toBe(2);
          const secondResize = sockets[1]!.sent.find((s) => s.includes('"resize"'));
          expect(secondResize).toBeDefined();
          expect(secondResize!.includes('"cols":200') && secondResize!.includes('"rows":50')).toBe(
            true,
          );
        }),
      );
    }),
  );

  it.effect("fails loudly when the first attach cannot send the create handshake", () =>
    Effect.gen(function* () {
      // The socket closes in the same tick as `open`, so `send` THROWS. As a
      // defect that throw slipped past runLifecycle's typed catch: the fork
      // died without failing `ready` and the open blocked forever. It must
      // surface as a typed failure instead.
      class ThrowingSocket extends FakeSocket {
        override send(): void {
          throw new Error("WebSocket is already in CLOSING or CLOSED state");
        }
      }
      const exit = yield* Effect.exit(
        Effect.scoped(
          openAetherTerminalConnection({
            restClient,
            apiBaseUrl: "https://api.runaether.dev",
            apiKey: "aether_test_key",
            taskId: "task-1",
            sessionId: "term-1",
            cols: 80,
            rows: 24,
            timing: ZERO_TIMING,
            webSocketFactory: () => {
              const socket = new ThrowingSocket();
              socket.open();
              return socket;
            },
            onOutput: () => {},
            onClosed: () => {},
          }),
        ),
      );
      expect(exit._tag).toBe("Failure");
    }),
  );
});
