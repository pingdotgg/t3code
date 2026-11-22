import { describe, expect, it, vi } from "vite-plus/test";
import type { OrbitGatewayRequest, OrbitGatewayTransport } from "./client.ts";
import {
  followOrbitOperationNotices,
  noticeSequence,
  OPERATION_LIVE_REREAD_MS,
  OPERATION_OFFLINE_POLL_MS,
  waitForOperationRead,
  type OrbitOperationNotices,
} from "./operationNotices.ts";
import type { OrbitRealtimeSocket } from "./realtimeSubscription.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function clock() {
  vi.useFakeTimers();
  return {
    [Symbol.dispose]() {
      vi.useRealTimers();
    },
  };
}
class Socket implements OrbitRealtimeSocket {
  readonly sent: Array<Record<string, unknown>> = [];
  readonly listeners = new Map<string, Array<(event: MessageEvent) => void>>();
  readonly subscribed = deferred<void>();
  closed = false;
  addEventListener(event: "message" | "close" | "error", listener: (event: MessageEvent) => void) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
  }
  send(text: string) {
    const value = JSON.parse(text);
    this.sent.push(value);
    if (value.event === "pusher:subscribe") this.subscribed.resolve();
  }
  close() {
    this.closed = true;
  }
  emit(event: string, data: unknown, channel = "private-operation.42") {
    for (const listener of this.listeners.get("message") ?? [])
      listener(
        new MessageEvent("message", {
          data: JSON.stringify({ event, data: JSON.stringify(data), channel }),
        }),
      );
  }
  disconnect() {
    for (const listener of this.listeners.get("close") ?? []) listener(new MessageEvent("close"));
  }
}
const response = (body: unknown) => ({ status: 200, body: JSON.stringify(body) });
const notice = (sequence: number) => ({
  type: "operation.updated",
  id: 42,
  at: "2026-11-22T14:40:12+00:00",
  data: { id: 42, kind: "instance.create", status: "running", sequence, current_step: "seed" },
});

/** Sleeps that end only when the test ends them. */
const sleeps: Array<{ ms: number; end: () => void }> = [];
const sleep = (ms: number) => new Promise<void>((end) => sleeps.push({ ms, end }));
const endSleep = (ms: number) => {
  const next = sleeps.shift();
  expect(next?.ms).toBe(ms);
  next?.end();
};
const wait = (notices: OrbitOperationNotices, sequence: number, maxMs = 60_000) =>
  waitForOperationRead({ notices, sequence, pollMs: 500, maxMs, sleep });

/** Records whether the wait ended once pending microtasks ran. */
async function settled(promise: Promise<void>, endMs?: number) {
  let done = false;
  void promise.then(() => {
    done = true;
  });
  if (endMs !== undefined) endSleep(endMs);
  await vi.advanceTimersByTimeAsync(0);
  return done;
}

describe("Operation notices over Reverb", () => {
  it("reads the sequence of a Gateway envelope and of a bare payload", () => {
    expect(noticeSequence(JSON.stringify(notice(7)))).toBe(7);
    expect(noticeSequence({ id: 42, sequence: 8 })).toBe(8);
    expect(noticeSequence({ id: 42 })).toBeNull();
  });

  it("wakes the reader on subscribe and on each newer notice, and drops stale ones", async () => {
    using _clock = clock();
    const requests: OrbitGatewayRequest[] = [];
    const opened = deferred<Socket>();
    const sockets: Socket[] = [];
    const transport: OrbitGatewayTransport = async (request) => {
      requests.push(request);
      return response(
        request.path === "/realtime"
          ? { data: { url: "wss://reverb.orbit", key: "test" } }
          : { auth: "signed" },
      );
    };
    const notices = followOrbitOperationNotices({
      transport,
      operationId: 42,
      socket: () => {
        const socket = new Socket();
        sockets.push(socket);
        opened.resolve(socket);
        return socket;
      },
    });
    const socket = await opened.promise;
    socket.emit("pusher:connection_established", { socket_id: "1.2" });
    await socket.subscribed.promise;
    expect(requests[1]).toMatchObject({
      path: "/broadcasting/auth",
      root: true,
      body: { socket_id: "1.2", channel_name: "private-operation.42" },
    });

    // The subscribe itself asks for one read: notices before it went nowhere.
    const first = notices.next(3);
    expect(await settled(first)).toBe(false);
    socket.emit("pusher_internal:subscription_succeeded", {});
    expect(await settled(first)).toBe(true);

    const second = notices.next(3);
    socket.emit("operation.updated", notice(3));
    socket.emit("operation.updated", notice(4), "private-operation.43");
    expect(await settled(second)).toBe(false);
    socket.emit("operation.updated", notice(4));
    expect(await settled(second)).toBe(true);

    // A notice that came between reads wakes the next wait at once, unless the read covered it.
    socket.emit("operation.updated", notice(6));
    expect(await settled(notices.next(5))).toBe(true);

    // Live, a quiet Operation is read again after Orbit's own 15 s; a later notice still counts.
    socket.emit("operation.updated", notice(7));
    const quiet = wait(notices, 7);
    expect(await settled(quiet)).toBe(false);
    expect(await settled(quiet, OPERATION_LIVE_REREAD_MS)).toBe(true);
    socket.emit("operation.updated", notice(8));
    expect(await settled(wait(notices, 7))).toBe(true);
    sleeps.shift();

    // Without the socket, the slow fallback reads and also subscribes again.
    socket.disconnect();
    expect(notices.live()).toBe(false);
    const offline = wait(notices, 8);
    expect(await settled(offline)).toBe(false);
    expect(await settled(offline, OPERATION_OFFLINE_POLL_MS)).toBe(true);
    expect(sockets).toHaveLength(2);

    const pending = notices.next(8);
    notices.stop();
    expect(await settled(pending)).toBe(true);
    expect(sockets[1]!.closed).toBe(true);
    expect(await settled(notices.next(8))).toBe(true);
  });

  it("never waits past the caller's limit, and polls as before without notices", async () => {
    using _clock = clock();
    const notices = followOrbitOperationNotices({
      transport: async () => response({ data: { url: null, key: null } }),
      operationId: 42,
    });
    const limited = wait(notices, 1, 300);
    expect(await settled(limited, 300)).toBe(true);
    notices.stop();
    const polled = waitForOperationRead({
      notices: null,
      sequence: null,
      pollMs: 500,
      maxMs: 1e9,
      sleep,
    });
    expect(await settled(polled, 500)).toBe(true);
    expect(sleeps).toEqual([]);
  });
});
