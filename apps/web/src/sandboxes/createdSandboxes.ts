import type { EnvironmentId } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";

// Sandboxes this window created, kept in view in the sidebar until a thread
// is started in one or it is dismissed. Lost on reload, like the dialog itself.
let created: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

function emit(next: ReadonlySet<string>) {
  created = next;
  for (const listener of listeners) listener();
}

/** Names a Sandbox across hosts, which may each have one of the same name. */
export const createdSandboxKey = (hostEnvironmentId: EnvironmentId, name: string) =>
  `${hostEnvironmentId}:${name}`;

export function rememberCreatedSandbox(hostEnvironmentId: EnvironmentId, name: string) {
  const key = createdSandboxKey(hostEnvironmentId, name);
  if (!created.has(key)) emit(new Set([...created, key]));
}

export function forgetCreatedSandbox(key: string) {
  if (!created.has(key)) return;
  const next = new Set(created);
  next.delete(key);
  emit(next);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useCreatedSandboxes(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, () => created);
}
