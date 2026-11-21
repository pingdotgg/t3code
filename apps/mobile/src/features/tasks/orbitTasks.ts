import {
  createOrbitTasksClient,
  followOrbitTasks,
  orbitTaskLane,
  type OrbitGatewayTransport,
  type OrbitTaskDetail,
  type OrbitTaskInsights,
  type OrbitTaskInsightsPeriod,
  type OrbitTasksClient,
  type OrbitTasksLiveStatus,
  type OrbitTasksResult,
  type OrbitTaskSummary,
} from "@t3tools/client-runtime/orbit-gateway";
import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";

import { orbitGatewayTransport } from "../orbit/orbitGatewayClient";
import { fixtureInsightTrend, fixtureOrbitTasksTransport } from "./orbitTasksFixtures";
import { listAllTasks } from "./taskList";
import { pollWhileActive } from "./taskInsightsPolling";
import { TASKS_FIXTURE_INSIGHTS, TASKS_FIXTURES } from "./tasksFixtureMode";

// Fixture data stays in the Gateway's wire form, so it still runs through the real decoder.
const USE_FIXTURES = TASKS_FIXTURES;

const transport: OrbitGatewayTransport = USE_FIXTURES
  ? fixtureOrbitTasksTransport({ insights: TASKS_FIXTURE_INSIGHTS })
  : orbitGatewayTransport;

/** One client for the app, so a realtime notice reaches every open Tasks screen. */
export const orbitTasksClient: OrbitTasksClient = createOrbitTasksClient(transport);

/** What the thread's task cards need to follow the same source as the Tasks tab. */
export const orbitTasksSource = { transport, fixtures: USE_FIXTURES } as const;

/** While a Tasks screen is focused: Orbit's realtime notices, plus a periodic authoritative read. */
function useFollowOrbitTasks() {
  const [live, setLive] = useState<OrbitTasksLiveStatus>("connecting");
  useFocusEffect(
    useCallback(() => {
      if (USE_FIXTURES) return undefined;
      return followOrbitTasks({ transport, client: orbitTasksClient, onStatus: setLive });
    }, []),
  );
  return live;
}

export type OrbitTasksState<A> = { readonly status: "loading" } | OrbitTasksResult<A>;

/** Every task this device may read. Keeps the last good list while a refresh fails. */
export function useOrbitTaskList() {
  const [state, setState] = useState<OrbitTasksState<ReadonlyArray<OrbitTaskSummary>>>({
    status: "loading",
  });
  const [durations, setDurations] = useState<ReadonlyMap<number, number>>(new Map());
  const [refreshing, setRefreshing] = useState(false);
  const request = useRef(0);
  const hasList = useRef(false);
  const read = useCallback(async () => {
    const current = ++request.current;
    const result = await listAllTasks(orbitTasksClient);
    if (current !== request.current) return;
    if (result.status !== "ok") {
      if (!hasList.current || result.reason !== "unreachable") setState(result);
      return;
    }
    hasList.current = true;
    setState(result);
    // The list carries no metrics; a running row's timer reads its task, only for running tasks.
    const running = result.value.filter((task) => orbitTaskLane(task.status) === "in-progress");
    const details = await Promise.all(running.map((task) => orbitTasksClient.getTask(task.id)));
    if (current !== request.current) return;
    setDurations(
      new Map(
        details.flatMap((detail) =>
          detail.status === "ok" && detail.value.metrics.durationMs !== null
            ? [[detail.value.id, detail.value.metrics.durationMs] as const]
            : [],
        ),
      ),
    );
  }, []);
  // Only while the list is on screen: a detail screen on top keeps it mounted, and the list
  // reads again when it comes back.
  useFocusEffect(
    useCallback(() => {
      const unsubscribe = orbitTasksClient.onInvalidate(() => read());
      void read();
      return unsubscribe;
    }, [read]),
  );
  useFollowOrbitTasks();
  const refresh = async () => {
    setRefreshing(true);
    await read().catch(() => undefined);
    setRefreshing(false);
  };
  return { state, durations, refreshing, refresh };
}

/** One task's detail, read again on every notice for it or for the list. */
export function useOrbitTask(taskId: number) {
  const [state, setState] = useState<OrbitTasksState<OrbitTaskDetail>>({ status: "loading" });
  const [refreshing, setRefreshing] = useState(false);
  const request = useRef(0);
  const hasTask = useRef(false);
  const read = useCallback(async () => {
    const current = ++request.current;
    const result = await orbitTasksClient.getTask(taskId);
    if (current !== request.current) return;
    // A dropped connection keeps what is on screen; a real answer (even an error) replaces it.
    if (
      result.status === "error" &&
      hasTask.current &&
      (result.reason === "unreachable" || result.reason === "invalid-response")
    )
      return;
    hasTask.current = result.status === "ok";
    setState(result);
  }, [taskId]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes before the first read so an invalidation during it is not lost
  useEffect(() => {
    hasTask.current = false;
    const unsubscribe = orbitTasksClient.onInvalidate((target) =>
      target.kind === "list" || target.taskId === taskId ? read() : undefined,
    );
    void read();
    return unsubscribe;
  }, [read, taskId]);
  useFollowOrbitTasks();
  const refresh = async () => {
    setRefreshing(true);
    await read().catch(() => undefined);
    setRefreshing(false);
  };
  return { state, refreshing, refresh };
}

/**
 * The lab's own series for a number. The fixture Gateway reports no per-day history for it, and
 * insightTrend would draw a flat line of zeros there. Always null outside the lab.
 */
export function labInsightTrend(id: string) {
  return USE_FIXTURES ? fixtureInsightTrend(id, Date.now()) : null;
}

/** Orbit's numbers move slowly; the strip re-reads every few minutes, like the desktop board. */
const INSIGHTS_POLL_MS = 300_000;

/**
 * The board's insights for the last `period`, read while the Tasks list is on screen. A failed
 * read replaces the numbers: stale numbers would read as current.
 */
export function useOrbitTaskInsights(period: OrbitTaskInsightsPeriod) {
  const [state, setState] = useState<OrbitTasksState<OrbitTaskInsights>>({ status: "loading" });
  useFocusEffect(
    useCallback(() => {
      let disposed = false;
      const stop = pollWhileActive({
        intervalMs: INSIGHTS_POLL_MS,
        app: {
          isActive: () => AppState.currentState === "active",
          onActive: (listener) => {
            const subscription = AppState.addEventListener("change", (next) => {
              if (next === "active") listener();
            });
            return () => subscription.remove();
          },
        },
        read: () =>
          void orbitTasksClient.getTaskInsights({ period }).then((result) => {
            if (!disposed) setState(result);
          }),
      });
      return () => {
        disposed = true;
        stop();
      };
    }, [period]),
  );
  return state;
}

/** Re-renders every 30 s while `active`, for minute timers on running rows. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- ticks a wall clock for running timers; stops when nothing runs
  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}
