import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { Atom } from "effect/unstable/reactivity";
import { useEffect, useRef, useState } from "react";

import { environmentCatalog } from "../connection/catalog";
import { isDesktopHostedConnectionTarget } from "../connection/desktopLocal";
import { useClientSettings } from "../hooks/useSettings";
import { environmentThreadShells } from "./threads";

/**
 * Discharging below this level releases the keep-awake assertion so the
 * feature cannot drain an already-low battery; charging or recovering above
 * it re-acquires automatically.
 */
export const KEEP_AWAKE_BATTERY_MIN_LEVEL = 0.1;

export interface BatteryState {
  readonly charging: boolean;
  /** 0..1, per the Battery Status API. */
  readonly level: number;
}

/**
 * A thread shell counts as working while its session is busy the way the
 * server defines busy: "starting" (prompt submitted, worktree/provider still
 * spinning up, and the gap between queued turns) or "running" with an active
 * turn. Turns parked on approvals or user input stay "running" on purpose:
 * the desktop hosts the server, so it must stay awake for a remote approval
 * to be able to arrive at all.
 */
export function isThreadShellWorking(shell: Pick<EnvironmentThreadShell, "session">): boolean {
  const session = shell.session;
  if (session == null) {
    return false;
  }
  return (
    session.status === "starting" || (session.status === "running" && session.activeTurnId != null)
  );
}

export function computeKeepAwake(input: {
  readonly enabled: boolean;
  readonly anyLocalAgentWorking: boolean;
  /** `null` means the Battery Status API is unavailable; treated as OK. */
  readonly battery: BatteryState | null;
}): boolean {
  if (!input.enabled || !input.anyLocalAgentWorking) {
    return false;
  }
  return (
    input.battery === null ||
    input.battery.charging ||
    input.battery.level >= KEEP_AWAKE_BATTERY_MIN_LEVEL
  );
}

export const anyLocalAgentWorkingAtom = Atom.make((get) => {
  const entries = get(environmentCatalog.catalogValueAtom).entries;
  return get(environmentThreadShells.threadShellsAtom).some((shell) => {
    const entry = entries.get(shell.environmentId);
    return (
      entry !== undefined &&
      isDesktopHostedConnectionTarget(entry.target) &&
      isThreadShellWorking(shell)
    );
  });
}).pipe(Atom.withLabel("desktop:any-local-agent-working"));

interface BatteryManagerLike extends EventTarget {
  readonly charging: boolean;
  readonly level: number;
}

type NavigatorWithBattery = Navigator & {
  getBattery?: () => Promise<BatteryManagerLike>;
};

function useBatteryState(): BatteryState | null {
  const [battery, setBattery] = useState<BatteryState | null>(null);

  useEffect(() => {
    const getBattery = (navigator as NavigatorWithBattery).getBattery;
    if (typeof getBattery !== "function") {
      return;
    }
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    getBattery
      .call(navigator)
      .then((manager) => {
        if (cancelled) {
          return;
        }
        const update = () => {
          setBattery((previous) =>
            previous !== null &&
            previous.charging === manager.charging &&
            previous.level === manager.level
              ? previous
              : { charging: manager.charging, level: manager.level },
          );
        };
        update();
        manager.addEventListener("chargingchange", update);
        manager.addEventListener("levelchange", update);
        unsubscribe = () => {
          manager.removeEventListener("chargingchange", update);
          manager.removeEventListener("levelchange", update);
        };
      })
      .catch(() => {
        // Battery state stays unknown, which computeKeepAwake treats as OK.
      });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  return battery;
}

/**
 * Drives the desktop shell's keep-awake assertion from the renderer, the only
 * layer that sees every environment. Each state is sent over IPC at most once
 * per flip; the initial send also resets main-process state after a renderer
 * reload. The assertion is released on unmount and on `pagehide`, because
 * React cleanups do not run when the renderer reloads.
 */
export function useDesktopCaffeination(): void {
  const enabled = useClientSettings((settings) => settings.caffeinateWhileAgentsRunning);
  const anyLocalAgentWorking = useAtomValue(anyLocalAgentWorkingAtom);
  const battery = useBatteryState();
  const keepAwake = computeKeepAwake({ enabled, anyLocalAgentWorking, battery });
  const lastSentRef = useRef<boolean | null>(null);

  useEffect(() => {
    const setKeepAwake = window.desktopBridge?.setKeepAwake;
    if (typeof setKeepAwake !== "function") {
      return;
    }
    const send = (value: boolean) => {
      if (lastSentRef.current === value) {
        return;
      }
      lastSentRef.current = value;
      void setKeepAwake(value).catch(() => {});
    };
    send(keepAwake);
    if (!keepAwake) {
      return;
    }
    const release = () => {
      send(false);
    };
    window.addEventListener("pagehide", release);
    return () => {
      window.removeEventListener("pagehide", release);
      release();
    };
  }, [keepAwake]);
}
