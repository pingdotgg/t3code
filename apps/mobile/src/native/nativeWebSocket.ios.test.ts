import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Socket from "effect/socket/Socket";
import { vi } from "vite-plus/test";

vi.mock("expo", () => ({ requireOptionalNativeModule: () => null }));

import * as NativeWebSocket from "./nativeWebSocket.ios";

function setup() {
  const listeners = new Map<string, (event: never) => void>();
  let nextId = 7;
  const native = {
    connect: vi.fn(() => nextId++),
    sendText: vi.fn(),
    sendBinary: vi.fn(),
    close: vi.fn(),
    addListener: vi.fn((event: string, listener: (event: never) => void) => {
      listeners.set(event, listener);
      return { remove: () => listeners.delete(event) };
    }),
  } satisfies NativeWebSocket.NativeModule;
  const emit = (event: "open" | "message" | "error" | "close", payload: Record<string, unknown>) =>
    listeners.get(event)?.(payload as never);
  const sockets = new NativeWebSocket.Sockets(native);
  const events: Array<Record<string, unknown>> = [];
  const socket = new NativeWebSocket.Connection(sockets, "ws://host/ws", ["t3"]);
  for (const type of ["open", "message", "error", "close"] as const) {
    socket.addEventListener(type, (event) => events.push({ ...event }));
  }
  return { native, emit, socket, events, sockets, id: 7 };
}

describe("NativeWebSocket", () => {
  it("opens, then delivers text and binary frames as string and ArrayBuffer", () => {
    const { native, emit, socket, events, id } = setup();
    expect(native.connect).toHaveBeenCalledWith("ws://host/ws", ["t3"]);
    expect(socket.readyState).toBe(NativeWebSocket.Connection.CONNECTING);
    expect(() => socket.send("early")).toThrow(/connecting/);

    emit("open", { id });
    expect(socket.readyState).toBe(NativeWebSocket.Connection.OPEN);

    const bytes = new Uint8Array([1, 2, 3]);
    emit("message", { id, text: "hello" });
    emit("message", { id, data: bytes.subarray(1) });
    emit("message", { id: id + 1, text: "other socket" });
    expect(events).toEqual([
      { type: "open" },
      { type: "message", data: "hello" },
      { type: "message", data: new Uint8Array([2, 3]) },
    ]);

    socket.send("out");
    socket.send(bytes);
    expect(native.sendText).toHaveBeenCalledWith(id, "out");
    expect(native.sendBinary).toHaveBeenCalledWith(id, bytes);
  });

  it("reports the server's close frame once and ignores later events", () => {
    const { emit, socket, events, id } = setup();
    emit("open", { id });
    emit("close", { id, code: 1001, reason: "going away", wasClean: true });
    emit("close", { id, code: 1006, reason: "", wasClean: false });
    emit("message", { id, text: "late" });
    expect(socket.readyState).toBe(NativeWebSocket.Connection.CLOSED);
    expect(events.slice(1)).toEqual([
      { type: "close", code: 1001, reason: "going away", wasClean: true },
    ]);
  });

  it("fires error before close when the handshake fails", () => {
    const { emit, events, id } = setup();
    emit("error", { id, message: "connection refused" });
    emit("close", { id, code: 1006, reason: "", wasClean: false });
    expect(events).toEqual([
      { type: "error", message: "connection refused" },
      { type: "close", code: 1006, reason: "", wasClean: false },
    ]);
  });

  it("closes through the native module once and honours once listeners", () => {
    const { native, emit, socket, id } = setup();
    const once = vi.fn();
    const always = vi.fn();
    socket.addEventListener("close", once, { once: true });
    socket.addEventListener("close", always);
    socket.addEventListener("close", always);
    emit("open", { id });
    socket.close(1000, "done");
    socket.close(1000, "again");
    expect(socket.readyState).toBe(NativeWebSocket.Connection.CLOSING);
    expect(native.close).toHaveBeenCalledTimes(1);
    expect(native.close).toHaveBeenCalledWith(id, 1000, "done");
    expect(() => socket.send("after close")).not.toThrow();
    expect(native.sendText).not.toHaveBeenCalled();

    socket.removeEventListener("close", always);
    emit("close", { id, code: 1000, reason: "", wasClean: true });
    expect(once).toHaveBeenCalledTimes(1);
    expect(always).not.toHaveBeenCalled();
  });

  it("closes open sockets and stops listening when disposed", () => {
    const { native, emit, socket, sockets, events, id } = setup();
    emit("open", { id });
    sockets.dispose();
    expect(native.close).toHaveBeenCalledWith(id, 1001, "");
    expect(socket.readyState).toBe(NativeWebSocket.Connection.CLOSED);
    expect(events.at(-1)).toEqual({ type: "close", code: 1001, reason: "", wasClean: false });
    expect(emit("message", { id, text: "late" })).toBeUndefined();
  });

  it.effect("surfaces a server close through Effect's socket as SocketCloseError", () =>
    Effect.gen(function* () {
      const { emit, socket, id } = setup();
      emit("open", { id });
      const effectSocket = yield* Socket.fromWebSocket(Effect.succeed(socket));
      const reader = yield* effectSocket.reader;
      emit("message", { id, text: "hi" });
      emit("close", { id, code: 1011, reason: "boom", wasClean: true });
      expect(yield* reader.pull).toEqual(["hi"]);
      const error = yield* Effect.flip(reader.pull);
      expect(error.reason).toMatchObject({
        _tag: "SocketCloseError",
        code: 1011,
        closeReason: "boom",
      });
    }).pipe(Effect.scoped),
  );
});
