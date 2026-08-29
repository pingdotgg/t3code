import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => {
  type Listener = (payload: Record<string, unknown>) => void;
  const nativeListeners = new Map<string, Listener>();
  const calls: Array<{ method: string; args: unknown[] }> = [];
  let platformOS = "ios";
  let moduleAvailable = true;

  const nativeModule = {
    connect: (...args: unknown[]) => calls.push({ method: "connect", args }),
    sendText: (...args: unknown[]) => calls.push({ method: "sendText", args }),
    sendBinary: (...args: unknown[]) => calls.push({ method: "sendBinary", args }),
    close: (...args: unknown[]) => calls.push({ method: "close", args }),
    addListener: (eventName: string, listener: Listener) => {
      nativeListeners.set(eventName, listener);
      return { remove: () => nativeListeners.delete(eventName) };
    },
  };

  return {
    calls,
    nativeListeners,
    emit: (eventName: string, payload: Record<string, unknown>) => {
      nativeListeners.get(eventName)?.(payload);
    },
    setPlatform: (os: string) => {
      platformOS = os;
    },
    setModuleAvailable: (available: boolean) => {
      moduleAvailable = available;
    },
    getPlatform: () => platformOS,
    getModule: () => (moduleAvailable ? nativeModule : null),
    // Native listeners intentionally survive reset: the wrapper attaches them
    // once per app lifetime, so clearing them here would not match production.
    reset: () => {
      calls.length = 0;
      platformOS = "ios";
      moduleAvailable = true;
    },
  };
});

vi.mock("react-native", () => ({
  Platform: {
    get OS() {
      return mocks.getPlatform();
    },
  },
}));

vi.mock("expo", () => ({
  requireOptionalNativeModule: () => mocks.getModule(),
}));

import { loadNativeWebSocketConstructor } from "./nativeWebSocket";

async function openSocket() {
  const construct = await loadNativeWebSocketConstructor();
  expect(construct).not.toBeNull();
  return construct!("wss://example.test/ws");
}

function lastCall(method: string) {
  const entries = mocks.calls.filter((call) => call.method === method);
  return entries[entries.length - 1];
}

function connectionIdOf(socket: WebSocket): number {
  void socket;
  return lastCall("connect")!.args[0] as number;
}

describe("nativeWebSocketConstructor", () => {
  beforeEach(() => {
    mocks.reset();
  });

  it("resolves null on Android and when the native module is missing", async () => {
    mocks.setPlatform("android");
    expect(await loadNativeWebSocketConstructor()).toBeNull();

    mocks.setPlatform("ios");
    mocks.setModuleAvailable(false);
    expect(await loadNativeWebSocketConstructor()).toBeNull();
  });

  it("connects and transitions readyState on open", async () => {
    const socket = await openSocket();
    const id = connectionIdOf(socket);
    expect(lastCall("connect")!.args).toEqual([id, "wss://example.test/ws", []]);
    expect(socket.readyState).toBe(0);

    const opened = vi.fn();
    socket.addEventListener("open", opened, { once: true });
    mocks.emit("onOpen", { id });
    expect(socket.readyState).toBe(1);
    expect(opened).toHaveBeenCalledTimes(1);

    // `once` listeners must not fire again.
    mocks.emit("onOpen", { id });
    expect(opened).toHaveBeenCalledTimes(1);
  });

  it("delivers text messages as strings and binary messages as bytes", async () => {
    const socket = await openSocket();
    const id = connectionIdOf(socket);
    const received: unknown[] = [];
    socket.addEventListener("message", (event) => {
      received.push((event as { data: unknown }).data);
    });

    mocks.emit("onMessage", { id, data: "hello", binary: false });
    mocks.emit("onMessage", { id, data: btoa("\x01\x02\x03"), binary: true });

    expect(received[0]).toBe("hello");
    expect(received[1]).toBeInstanceOf(Uint8Array);
    expect([...(received[1] as Uint8Array)]).toEqual([1, 2, 3]);
  });

  it("sends binary data base64-encoded and strings as text", async () => {
    const socket = await openSocket();
    const id = connectionIdOf(socket);

    socket.send("ping");
    expect(lastCall("sendText")!.args).toEqual([id, "ping"]);

    socket.send(new Uint8Array([1, 2, 3]));
    expect(lastCall("sendBinary")!.args).toEqual([id, btoa("\x01\x02\x03")]);
  });

  it("dispatches close once and routes messages by connection id", async () => {
    const first = await openSocket();
    const firstId = connectionIdOf(first);
    const second = await openSocket();
    const secondId = connectionIdOf(second);
    expect(firstId).not.toBe(secondId);

    const firstClosed = vi.fn();
    const secondClosed = vi.fn();
    first.addEventListener("close", firstClosed);
    second.addEventListener("close", secondClosed);

    mocks.emit("onClose", { id: firstId, code: 1000, reason: "done" });
    mocks.emit("onClose", { id: firstId, code: 1000, reason: "done" });

    expect(firstClosed).toHaveBeenCalledTimes(1);
    expect(first.readyState).toBe(3);
    expect(secondClosed).not.toHaveBeenCalled();
    expect(second.readyState).toBe(0);
  });

  it("close() is idempotent and forwards code and reason", async () => {
    const socket = await openSocket();
    const id = connectionIdOf(socket);

    socket.close(4000, "bye");
    socket.close(4000, "bye");

    const closeCalls = mocks.calls.filter((call) => call.method === "close");
    expect(closeCalls).toHaveLength(1);
    expect(closeCalls[0]!.args).toEqual([id, 4000, "bye"]);
    expect(socket.readyState).toBe(2);
  });

  it("ignores a native open that lands after close", async () => {
    const socket = await openSocket();
    const id = connectionIdOf(socket);
    const opened = vi.fn();
    socket.addEventListener("open", opened);

    // Effect closes while still CONNECTING (open timeout or scope teardown);
    // the in-flight native connect can still report success afterwards.
    socket.close(1000, "");
    mocks.emit("onOpen", { id });

    expect(opened).not.toHaveBeenCalled();
    expect(socket.readyState).toBe(2);
  });
});
