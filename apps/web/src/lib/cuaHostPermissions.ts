import { useCallback, useEffect, useState } from "react";

import { isElectron } from "../env";

export interface CuaHostPermissions {
  readonly accessibility: boolean;
  readonly screenRecording: boolean;
}

const CACHE_TTL_MS = 5_000;
let cached: { readonly at: number; readonly value: CuaHostPermissions } | null = null;
let inFlight: Promise<CuaHostPermissions | null> | null = null;

/** Whether this desktop can act on its own screen right now. Null where no desktop can answer. */
export function readCuaHostPermissions(): Promise<CuaHostPermissions | null> {
  const bridge = isElectron ? window.desktopBridge : undefined;
  if (!bridge?.checkSystemPermission || bridge.getClientPlatform?.() !== "darwin") {
    return Promise.resolve(null);
  }
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return Promise.resolve(cached.value);
  inFlight ??= Promise.all([
    bridge.checkSystemPermission("accessibility"),
    bridge.checkSystemPermission("screen-recording"),
  ])
    .then(([accessibility, screenRecording]) => {
      const value = { accessibility, screenRecording };
      cached = { at: Date.now(), value };
      return value;
    })
    .catch(() => null)
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

export function cuaHostPermissionsReady(permissions: CuaHostPermissions | null): boolean {
  return permissions === null || (permissions.accessibility && permissions.screenRecording);
}

/**
 * Polls only on mount and when the window regains focus, which is when a grant
 * in System Settings can have changed. `enabled` false skips the check.
 */
export function useCuaHostPermissions(enabled: boolean) {
  const [permissions, setPermissions] = useState<CuaHostPermissions | null>(null);
  const refresh = useCallback(() => {
    if (!enabled) return;
    void readCuaHostPermissions().then((value) => setPermissions(value));
  }, [enabled]);
  useEffect(() => {
    if (!enabled) {
      setPermissions(null);
      return;
    }
    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [enabled, refresh]);
  return { permissions, ready: cuaHostPermissionsReady(permissions), refresh };
}
