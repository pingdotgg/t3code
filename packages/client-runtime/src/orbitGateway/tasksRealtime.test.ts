import { describe, expect, it, vi } from "vite-plus/test";
import type { OrbitGatewayRequest, OrbitGatewayTransport } from "./client.ts";
import type { OrbitRealtimeSocket } from "./realtimeSubscription.ts";
import type { OrbitTasksInvalidation } from "./tasks.ts";
import { followOrbitTasks, orbitTaskNotice, ORBIT_TASKS_REFRESH_MS } from "./tasksRealtime.ts";

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
  emit(event: string, data: unknown, channel = "private-orbit") {
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
const response = (body: unknown, status = 200) => ({ status, body: JSON.stringify(body) });

describe("Orbit task summary refresh", () => {
  it("maps only task notices to authoritative invalidations", () => {
    expect(orbitTaskNotice("task_group.created", { id: 1 })).toEqual({ kind: "task", taskId: 1 });
    expect(orbitTaskNotice("task_group.updated", JSON.stringify({ id: 2 }))).toEqual({
      kind: "task",
      taskId: 2,
    });
    expect(
      orbitTaskNotice("agent_thread.updated", { id: 99, task_group_id: 3, task_id: 4 }),
    ).toEqual({ kind: "task", taskId: 3 });
    expect(orbitTaskNotice("tasks.updated", { enabled: false })).toEqual({ kind: "list" });
    expect(orbitTaskNotice("agent_thread.updated", { task_id: 4 })).toBeNull();
    expect(orbitTaskNotice("unrelated", { id: 1 })).toBeNull();
    expect(orbitTaskNotice("task_group.updated", { id: "1" })).toBeNull();
  });

  it("authenticates the private channel, batches bursts, refreshes on reconnect, and disposes", async () => {
    using _clock = clock();
    const requests: OrbitGatewayRequest[] = [];
    const sockets: Socket[] = [];
    const opened = deferred<Socket>();
    const invalidations: OrbitTasksInvalidation[] = [];
    const statuses: string[] = [];
    const transport: OrbitGatewayTransport = async (request) => {
      requests.push(request);
      return response(
        request.path === "/realtime"
          ? { data: { url: "wss://reverb.orbit", key: "test" } }
          : { auth: "signed" },
      );
    };
    const stop = followOrbitTasks({
      transport,
      client: {
        invalidate: async (target) => {
          invalidations.push(target);
        },
      },
      onStatus: (status) => statuses.push(status),
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
      method: "POST",
      body: { socket_id: "1.2", channel_name: "private-orbit" },
    });
    expect(socket.sent[0]).toEqual({
      event: "pusher:subscribe",
      data: { channel: "private-orbit", auth: "signed" },
    });
    socket.emit("task_group.updated", { id: 55 });
    socket.emit("pusher_internal:subscription_succeeded", {}, "private-other");
    await vi.advanceTimersByTimeAsync(250);
    expect(invalidations).toEqual([]);
    expect(statuses).toEqual(["connecting"]);
    socket.emit("pusher_internal:subscription_succeeded", {});
    await vi.advanceTimersByTimeAsync(250);
    expect(invalidations).toEqual([{ kind: "list" }]);
    socket.emit("task_group.updated", { id: 55 }, "private-other");
    for (let i = 0; i < 100; i++) socket.emit("task_group.updated", { id: 482 });
    await vi.advanceTimersByTimeAsync(250);
    expect(invalidations).toEqual([{ kind: "list" }, { kind: "task", taskId: 482 }]);
    socket.emit("pusher:ping", {});
    expect(socket.sent.at(-1)).toEqual({ event: "pusher:pong", data: {} });
    socket.disconnect();
    expect(statuses.at(-1)).toBe("polling");
    await vi.advanceTimersByTimeAsync(2 * ORBIT_TASKS_REFRESH_MS);
    expect(sockets).toHaveLength(2);
    const reconnected = sockets[1]!;
    reconnected.emit("pusher:connection_established", { socket_id: "3.4" });
    await reconnected.subscribed.promise;
    reconnected.emit("pusher_internal:subscription_succeeded", {});
    await vi.advanceTimersByTimeAsync(250);
    expect(statuses.at(-1)).toBe("live");
    expect(invalidations.at(-1)).toEqual({ kind: "list" });
    stop();
    const count = invalidations.length;
    reconnected.emit("task_group.updated", { id: 482 });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(invalidations).toHaveLength(count);
    expect(sockets).toHaveLength(2);
    expect(reconnected.closed).toBe(true);
  });

  it("polls after discovery/access failure without overlapping reads or rapid retries", async () => {
    using _clock = clock();
    const refused = deferred<void>();
    const gate = deferred<void>();
    let discoveries = 0;
    let reads = 0;
    let active = 0;
    let peak = 0;
    const stop = followOrbitTasks({
      transport: async () => {
        discoveries++;
        return response({ error: { code: "node_access.required" } }, 403);
      },
      onStatus: (status) => {
        if (status === "polling") refused.resolve();
      },
      client: {
        invalidate: async () => {
          reads++;
          active++;
          peak = Math.max(peak, active);
          await gate.promise;
          active--;
        },
      },
    });
    await refused.promise;
    await vi.advanceTimersByTimeAsync(ORBIT_TASKS_REFRESH_MS);
    expect(reads).toBe(1);
    await vi.advanceTimersByTimeAsync(3 * ORBIT_TASKS_REFRESH_MS);
    expect(reads).toBe(1);
    expect(discoveries).toBe(1);
    gate.resolve();
    await vi.advanceTimersByTimeAsync(ORBIT_TASKS_REFRESH_MS);
    expect(peak).toBe(1);
    stop();
    const count = reads;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(reads).toBe(count);
  });

  it("cannot create a socket after disposal during discovery", async () => {
    using _clock = clock();
    const discovery = deferred<ReturnType<typeof response>>();
    const socket = vi.fn(() => new Socket());
    const invalidate = vi.fn(async () => {});
    const stop = followOrbitTasks({
      transport: () => discovery.promise,
      socket,
      client: { invalidate },
      onStatus: () => {},
    });
    stop();
    discovery.resolve(response({ data: { url: "wss://reverb.orbit", key: "key" } }));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(socket).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
  });
});
