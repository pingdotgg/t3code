import {
  followOrbitTasks,
  type OrbitTaskDetail,
  type OrbitTasksInvalidation,
} from "@t3tools/client-runtime/orbit-gateway";
import { useCallback, useSyncExternalStore } from "react";

import { orbitTasksClient, orbitTasksSource } from "./orbitTasks";

// The task cards in a thread read tasks by id from the client the Tasks tab uses. One store holds
// the last good read per task, so many cards share one read, one invalidation listener and one
// realtime follower, however many are mounted.

const tasks = new Map<number, OrbitTaskDetail>();
const watchers = new Map<number, number>();
const listeners = new Set<() => void>();
const latestReadSeq = new Map<number, number>();
let stopFollowing: (() => void) | null = null;
let stopInvalidation: (() => void) | null = null;
let generation = 0;
let readSeq = 0;

function emit() {
  for (const listener of listeners) listener();
}

function read(taskId: number) {
  const started = generation;
  const seq = (readSeq += 1);
  latestReadSeq.set(taskId, seq);
  void orbitTasksClient.getTask(taskId).then((result) => {
    // An error or a newer read keeps what the card already shows.
    if (result.status !== "ok" || started !== generation || latestReadSeq.get(taskId) !== seq) {
      return;
    }
    tasks.set(taskId, result.value);
    emit();
  });
}

function onInvalidate(target: OrbitTasksInvalidation) {
  for (const taskId of watchers.keys()) {
    if (target.kind === "list" || target.taskId === taskId) read(taskId);
  }
}

function start() {
  stopInvalidation = orbitTasksClient.onInvalidate(onInvalidate);
  // The lab's fixture Gateway has no realtime socket.
  if (!orbitTasksSource.fixtures) {
    stopFollowing = followOrbitTasks({
      transport: orbitTasksSource.transport,
      client: orbitTasksClient,
      onStatus: () => {},
    });
  }
}

function stop() {
  generation += 1;
  latestReadSeq.clear();
  stopInvalidation?.();
  stopFollowing?.();
  stopInvalidation = null;
  stopFollowing = null;
}

function watch(taskId: number, listener: () => void) {
  if (watchers.size === 0) start();
  const count = watchers.get(taskId) ?? 0;
  watchers.set(taskId, count + 1);
  listeners.add(listener);
  if (count === 0) read(taskId);
  return () => {
    listeners.delete(listener);
    const left = (watchers.get(taskId) ?? 1) - 1;
    if (left > 0) {
      watchers.set(taskId, left);
    } else {
      watchers.delete(taskId);
      latestReadSeq.delete(taskId);
    }
    if (watchers.size === 0) stop();
  };
}

/** The task, with its metrics, as Orbit has it now, or null until the first read lands or when Orbit is unreachable. */
export function useLiveOrbitTask(taskId: number): OrbitTaskDetail | null {
  const subscribe = useCallback((listener: () => void) => watch(taskId, listener), [taskId]);
  return useSyncExternalStore(
    subscribe,
    () => tasks.get(taskId) ?? null,
    () => null,
  );
}
