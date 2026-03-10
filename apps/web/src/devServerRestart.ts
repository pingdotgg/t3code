import { useMemo } from "react";
import { create } from "zustand";

import { toastManager } from "./components/ui/toast";
import { resolveServerHttpOrigin } from "./serverConnection";
import { onServerWelcome } from "./wsNativeApi";

type DevServerRestartStatus = "idle" | "starting" | "restarting" | "connected";
const AUTO_START_DELAY_MS = 1200;
let autoStartAttempted = false;

interface DevServerRestartStore {
  status: DevServerRestartStatus;
  restartInFlight: boolean;
  startInFlight: boolean;
  serverVersion: string | null;
  lastWelcomeAt: string | null;
  restart: () => Promise<void>;
  start: () => Promise<void>;
}

const useDevServerRestartStore = create<DevServerRestartStore>((set, get) => ({
  status: "idle",
  restartInFlight: false,
  startInFlight: false,
  serverVersion: null,
  lastWelcomeAt: null,
  restart: async () => {
    const status = get().status;
    if (status === "restarting" || status === "starting") {
      return;
    }
    set({ status: "restarting", restartInFlight: true });
    try {
      const response = await fetch(`${resolveServerHttpOrigin()}/api/dev-restart`, {
        method: "POST",
      });
      if (!response.ok) {
        throw new Error(`Restart failed (${response.status})`);
      }
    } catch (error) {
      set({ status: "idle", restartInFlight: false });
      toastManager.add({
        type: "error",
        title: "Restart failed",
        description: error instanceof Error ? error.message : "Unable to restart dev server.",
      });
    }
  },
  start: async () => {
    const status = get().status;
    if (status === "starting" || status === "restarting") {
      return;
    }
    if (!import.meta.env.DEV) {
      toastManager.add({
        type: "warning",
        title: "Start unavailable",
        description: "Starting the dev server is only supported in dev mode.",
      });
      return;
    }
    set({ status: "starting", startInFlight: true });
    try {
      const response = await fetch("/api/dev-start", {
        method: "POST",
      });
      if (!response.ok) {
        throw new Error(`Start failed (${response.status})`);
      }
    } catch (error) {
      set({ status: "idle", startInFlight: false });
      toastManager.add({
        type: "error",
        title: "Start failed",
        description: error instanceof Error ? error.message : "Unable to start dev server.",
      });
    }
  },
}));

if (typeof window !== "undefined") {
  onServerWelcome((payload) => {
    const { restartInFlight, startInFlight } = useDevServerRestartStore.getState();
    useDevServerRestartStore.setState({
      status: "connected",
      restartInFlight: false,
      startInFlight: false,
      serverVersion: payload.serverVersion ?? null,
      lastWelcomeAt: new Date().toISOString(),
    });
    if (restartInFlight) {
      window.setTimeout(() => {
        window.location.reload();
      }, 200);
    }
    if (startInFlight) {
      // Allow the client to reconnect without forcing a reload.
    }
  });

  if (import.meta.env.DEV) {
    window.setTimeout(() => {
      if (autoStartAttempted) return;
      const { status, start } = useDevServerRestartStore.getState();
      if (status !== "connected") {
        autoStartAttempted = true;
        void start();
      }
    }, AUTO_START_DELAY_MS);
  }
}

export function useDevServerRestart() {
  const status = useDevServerRestartStore((state) => state.status);
  const restart = useDevServerRestartStore((state) => state.restart);
  const start = useDevServerRestartStore((state) => state.start);
  const serverVersion = useDevServerRestartStore((state) => state.serverVersion);
  const lastWelcomeAt = useDevServerRestartStore((state) => state.lastWelcomeAt);

  return useMemo(
    () => ({
      status,
      restart,
      start,
      serverVersion,
      lastWelcomeAt,
    }),
    [lastWelcomeAt, restart, serverVersion, start, status],
  );
}
