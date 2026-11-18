// @effect-diagnostics globalTimers:off -- This browser socket lifecycle owns native timers, covered with fake-time tests.
import type { OrbitGatewayTransport } from "./client.ts";
import {
  createOrbitRealtimeSubscription,
  realtimeObject,
  type OrbitRealtimeSocket,
} from "./realtimeSubscription.ts";
import type { OrbitTasksClient, OrbitTasksInvalidation } from "./tasks.ts";

export type OrbitTasksLiveStatus = "connecting" | "live" | "polling";
export const ORBIT_TASKS_REFRESH_MS = 30_000;
const BATCH_MS = 250;

export function orbitTaskNotice(event: string, data: unknown): OrbitTasksInvalidation | null {
  const payload = realtimeObject(data);
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

/** One active-panel summary connection. Notices coalesce; periodic reads also refresh metrics. */
export function followOrbitTasks(input: {
  transport: OrbitGatewayTransport;
  client: Pick<OrbitTasksClient, "invalidate">;
  onStatus: (status: OrbitTasksLiveStatus) => void;
  socket?: (url: string) => OrbitRealtimeSocket;
}): () => void {
  let stopped = false;
  let live = false;
  let batch: OrbitTasksInvalidation | null = null;
  let refreshing = false;
  let batchTimer: ReturnType<typeof setTimeout> | undefined;
  let tickTimer: ReturnType<typeof setTimeout> | undefined;
  let cycles = 0;
  const status = (value: OrbitTasksLiveStatus) => {
    if (!stopped) input.onStatus(value);
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
  const subscription = createOrbitRealtimeSubscription({
    transport: input.transport,
    discoveryPath: "/realtime",
    authPath: "/broadcasting/auth",
    root: true,
    channel: "private-orbit",
    onStatus: (connection) => {
      live = connection === "live";
      status(live ? "live" : "polling");
      if (live) enqueue({ kind: "list" });
    },
    onEvent: (event, data) => {
      const target = orbitTaskNotice(event, data);
      if (target) enqueue(target);
    },
    ...(input.socket ? { socket: input.socket } : {}),
  });
  const tick = async () => {
    if (stopped) return;
    // A complete authoritative read is also necessary while live: metric-only changes emit no event.
    enqueue({ kind: "list" });
    clearTimeout(batchTimer);
    batchTimer = undefined;
    await refresh();
    cycles += 1;
    if (!live && cycles % 2 === 0) void subscription.connect();
    if (!stopped) tickTimer = setTimeout(() => void tick(), ORBIT_TASKS_REFRESH_MS);
  };
  status("connecting");
  void subscription.connect();
  tickTimer = setTimeout(() => void tick(), ORBIT_TASKS_REFRESH_MS);
  return () => {
    stopped = true;
    clearTimeout(batchTimer);
    clearTimeout(tickTimer);
    subscription.stop();
  };
}
