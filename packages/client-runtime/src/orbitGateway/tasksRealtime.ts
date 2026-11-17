// @effect-diagnostics globalTimers:off -- This browser socket lifecycle owns native timers, covered with fake-time tests.
import type { OrbitGatewayTransport } from "./client.ts";
import type { OrbitTasksClient, OrbitTasksInvalidation } from "./tasks.ts";

export type OrbitTasksLiveStatus = "connecting" | "live" | "polling";
export const ORBIT_TASKS_REFRESH_MS = 30_000;
const BATCH_MS = 250;

function object(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      return object(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function orbitTaskNotice(event: string, data: unknown): OrbitTasksInvalidation | null {
  const payload = object(data);
  if (event === "tasks.updated") return { kind: "list" };
  const id =
    event === "agent_thread.updated"
      ? payload?.task_group_id
      : event === "task_group.updated" || event === "task_group.created"
        ? payload?.id
        : null;
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0
    ? { kind: "task", taskId: id }
    : null;
}

export interface TasksSocket {
  send(data: string): void;
  close(): void;
  addEventListener(event: "message", listener: (event: MessageEvent) => void): void;
  addEventListener(event: "close" | "error", listener: () => void): void;
}

/** One active-panel summary connection. Notices coalesce; periodic reads also refresh metrics. */
export function followOrbitTasks(input: {
  transport: OrbitGatewayTransport;
  client: Pick<OrbitTasksClient, "invalidate">;
  onStatus: (status: OrbitTasksLiveStatus) => void;
  socket?: (url: string) => TasksSocket;
}): () => void {
  let stopped = false;
  let socket: TasksSocket | null = null;
  let connecting = false;
  let live = false;
  let batch: OrbitTasksInvalidation | null = null;
  let refreshing = false;
  let batchTimer: ReturnType<typeof setTimeout> | undefined;
  let tickTimer: ReturnType<typeof setTimeout> | undefined;
  let handshakeTimer: ReturnType<typeof setTimeout> | undefined;
  let cycles = 0;
  const status = (value: OrbitTasksLiveStatus) => {
    if (!stopped) input.onStatus(value);
  };
  const closeSocket = () => {
    clearTimeout(handshakeTimer);
    const previous = socket;
    socket = null;
    previous?.close();
    live = false;
  };
  const fallback = () => {
    closeSocket();
    status("polling");
  };
  const refresh = async () => {
    if (stopped || refreshing || batch === null) return;
    const target = batch;
    batch = null;
    refreshing = true;
    try {
      await input.client.invalidate(target);
    } finally {
      refreshing = false;
      if (!stopped && batch !== null)
        batchTimer = setTimeout(() => {
          batchTimer = undefined;
          void refresh();
        }, BATCH_MS);
    }
  };
  const enqueue = (target: OrbitTasksInvalidation) => {
    if (stopped) return;
    batch =
      batch === null
        ? target
        : batch.kind === "task" && target.kind === "task" && batch.taskId === target.taskId
          ? batch
          : { kind: "list" };
    if (!refreshing && batchTimer === undefined) {
      batchTimer = setTimeout(() => {
        batchTimer = undefined;
        void refresh();
      }, BATCH_MS);
    }
  };
  const request = async (path: string, body?: Record<string, string>) => {
    const response = await input.transport({
      method: body ? "POST" : "GET",
      path,
      root: true,
      ...(body ? { body } : {}),
      timeoutMs: 10_000,
    });
    if (response.status < 200 || response.status >= 300) throw new Error("Realtime unavailable");
    const envelope = object(response.body);
    return object(envelope?.data) ?? envelope;
  };
  const connect = async () => {
    if (stopped || connecting || socket !== null) return;
    connecting = true;
    try {
      const config = await request("/realtime");
      if (stopped) return;
      if (typeof config?.url !== "string" || typeof config.key !== "string")
        throw new Error("Invalid realtime discovery");
      const url = new URL(config.url);
      if (url.protocol !== "wss:" && url.protocol !== "ws:")
        throw new Error("Invalid realtime URL");
      url.pathname = `/app/${encodeURIComponent(config.key)}`;
      url.search = "protocol=7&client=conn&version=1";
      const current: TasksSocket = input.socket
        ? input.socket(url.toString())
        : new WebSocket(url.toString());
      socket = current;
      handshakeTimer = setTimeout(fallback, 15_000);
      current.addEventListener("close", () => {
        if (socket === current) fallback();
      });
      current.addEventListener("error", () => {
        if (socket === current) fallback();
      });
      current.addEventListener("message", (event) => {
        if (stopped || socket !== current) return;
        const message = object(event.data);
        const data = object(message?.data);
        if (message?.event === "pusher:ping") {
          current.send(JSON.stringify({ event: "pusher:pong", data: {} }));
        } else if (
          message?.event === "pusher:connection_established" &&
          typeof data?.socket_id === "string"
        ) {
          void request("/broadcasting/auth", {
            socket_id: data.socket_id,
            channel_name: "private-orbit",
          })
            .then((auth) => {
              if (stopped || socket !== current) return;
              if (typeof auth?.auth !== "string") {
                fallback();
                return;
              }
              current.send(
                JSON.stringify({
                  event: "pusher:subscribe",
                  data: { channel: "private-orbit", auth: auth.auth },
                }),
              );
            })
            .catch(() => {
              if (socket === current) fallback();
            });
        } else if (
          message?.channel === "private-orbit" &&
          message.event === "pusher_internal:subscription_succeeded"
        ) {
          clearTimeout(handshakeTimer);
          live = true;
          status("live");
          enqueue({ kind: "list" });
        } else if (
          message?.event === "pusher:error" ||
          message?.event === "pusher:subscription_error"
        ) {
          fallback();
        } else if (message?.channel === "private-orbit" && typeof message.event === "string") {
          const target = orbitTaskNotice(message.event, message.data);
          if (target) enqueue(target);
        }
      });
    } catch {
      if (!stopped) fallback();
    } finally {
      connecting = false;
    }
  };
  const tick = async () => {
    if (stopped) return;
    // A complete authoritative read is also necessary while live: metric-only changes emit no event.
    enqueue({ kind: "list" });
    clearTimeout(batchTimer);
    batchTimer = undefined;
    await refresh();
    cycles += 1;
    if (!live && cycles % 2 === 0) void connect();
    if (!stopped) tickTimer = setTimeout(() => void tick(), ORBIT_TASKS_REFRESH_MS);
  };
  status("connecting");
  void connect();
  tickTimer = setTimeout(() => void tick(), ORBIT_TASKS_REFRESH_MS);
  return () => {
    stopped = true;
    clearTimeout(batchTimer);
    clearTimeout(tickTimer);
    closeSocket();
  };
}
