import type {
  OrbitTaskSummary,
  OrbitTasksInvalidation,
} from "@t3tools/client-runtime/orbit-gateway";
import { useSyncExternalStore } from "react";

import { followTasksUpdates, loadOrbitTasksClient } from "./orbitTasksClient";

// Task cards in the chat and the thread details read tasks by id from the same client the Tasks
// board uses. One store holds the last good read per task, so many cards share one read, one
// invalidation listener and one realtime follower, however many are mounted.

const tasks = new Map<number, OrbitTaskSummary>();
const watchers = new Map<number, number>();
const listeners = new Set<() => void>();
let stopFollowing: (() => void) | null = null;
let stopInvalidation: (() => void) | null = null;
let generation = 0;

function emit() {
  for (const listener of listeners) listener();
}

function read(taskId: number) {
  const started = generation;
  void loadOrbitTasksClient().then(async (client) => {
    const result = await client?.getTask(taskId);
    // An error keeps what the card already shows.
    if (result?.status !== "ok" || started !== generation) return;
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
  const started = generation;
  void loadOrbitTasksClient().then((client) => {
    if (!client || started !== generation || stopFollowing !== null) return;
    stopInvalidation = client.onInvalidate(onInvalidate);
    stopFollowing = followTasksUpdates(client, () => {});
  });
}

function stop() {
  generation += 1;
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
    if (left > 0) watchers.set(taskId, left);
    else watchers.delete(taskId);
    if (watchers.size === 0) stop();
  };
}

/** The task as Orbit has it now, or null until the first read lands or when Orbit is unreachable. */
export function useLiveOrbitTask(taskId: number): OrbitTaskSummary | null {
  const subscribe = (listener: () => void) => watch(taskId, listener);
  return useSyncExternalStore(
    subscribe,
    () => tasks.get(taskId) ?? null,
    () => null,
  );
}
