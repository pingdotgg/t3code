import type { DesktopBridge, PluginSnapshot } from "@t3tools/contracts";
import { useEffect, useSyncExternalStore } from "react";
import { pluginSharedState } from "./features";

interface DesktopPluginState {
  readonly snapshot: PluginSnapshot | null;
  readonly error: string | null;
  readonly pending: string | null;
}
const state = pluginSharedState("desktop-plugin-management", () => ({
  value: { snapshot: null, error: null, pending: null } as DesktopPluginState,
  listeners: new Set<() => void>(),
  initialized: false,
}));
const subscribe = (listener: () => void) => {
  state.listeners.add(listener);
  return () => {
    state.listeners.delete(listener);
  };
};
const publish = (value: DesktopPluginState) => {
  state.value = value;
  for (const listener of state.listeners) listener();
};

async function update(
  id: string,
  run: (bridge: NonNullable<DesktopBridge["plugins"]>) => Promise<PluginSnapshot>,
) {
  const bridge = window.desktopBridge?.plugins;
  if (!bridge || state.value.pending !== null) return;
  publish({ ...state.value, pending: id, error: null });
  try {
    const snapshot = await run(bridge);
    state.initialized = true;
    publish({ snapshot, pending: null, error: null });
  } catch (error) {
    publish({
      ...state.value,
      pending: null,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export const reloadDesktopPlugins = (id?: string) =>
  update(id ?? "refresh", (bridge) => bridge.reload(id === undefined ? {} : { id }));
export const setDesktopPluginEnabled = (id: string, enabled: boolean) =>
  update(id, (bridge) => bridge.setEnabled({ id, enabled }));

/** Settings and recovery share snapshots from the real desktop management bridge. */
export function useDesktopPlugins() {
  const value = useSyncExternalStore(
    subscribe,
    () => state.value,
    () => state.value,
  );
  const available = window.desktopBridge?.plugins !== undefined;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- requests the first plugin snapshot from the desktop bridge when one is available
  useEffect(() => {
    if (available && !state.initialized) void update("refresh", (bridge) => bridge.list());
  }, [available]);
  return { ...value, available };
}
