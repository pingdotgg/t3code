import { useEffect, useRef } from "react";
import { useStableCallback } from "../hooks/useStableCallback";
import {
  getClientSettings,
  isClientSettingsHydrated,
  updateClientSettings,
} from "../hooks/useSettings";
import {
  type MicrophoneEntry,
  microphoneOrder,
  preferredMicrophoneId,
  rememberMicrophones,
} from "./microphoneOrder";
import { msg } from "gt-react";
import { m } from "../i18n/messages";

export type BrowserMicrophone = Pick<MediaDeviceInfo, "deviceId" | "label">;

/** Audio inputs as the browser reports them. Labels stay empty until microphone permission. */
async function listAudioInputs(): Promise<BrowserMicrophone[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((device) => device.kind === "audioinput")
    .map(({ deviceId, label }) => ({ deviceId, label }));
}

export function labelBrowserMicrophones(devices: BrowserMicrophone[]): BrowserMicrophone[] {
  return devices.map(({ deviceId, label }, index) => ({
    deviceId,
    label: label || m(msg("Microphone {number}", { number: index + 1 })),
  }));
}

/** Delivers the latest scan's result, or null if it fails, while the view is enabled. */
export function useMicrophoneRefresh({
  enabled,
  onStart,
  onResult,
}: {
  enabled: boolean;
  onStart?: () => void;
  onResult: (devices: BrowserMicrophone[] | null) => void;
}) {
  const latest = useRef<symbol | null>(null);
  const reportResult = useStableCallback((devices: BrowserMicrophone[] | null) => {
    if (enabled) onResult(devices);
  });
  const refresh = useStableCallback(async () => {
    if (!enabled || latest.current === null || !navigator.mediaDevices?.enumerateDevices) return;
    const scan = Symbol();
    latest.current = scan;
    onStart?.();
    const devices = await listAudioInputs().catch(() => null);
    if (latest.current === scan) reportResult(devices);
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- observes browser device changes and invalidates pending scans on cleanup
  useEffect(() => {
    if (!enabled) return;
    const initial = Symbol();
    latest.current = initial;
    queueMicrotask(() => {
      if (latest.current === initial) void refresh();
    });
    const devices = navigator.mediaDevices;
    devices?.addEventListener?.("devicechange", refresh);
    return () => {
      latest.current = null;
      devices?.removeEventListener?.("devicechange", refresh);
    };
  }, [enabled, refresh]);

  return refresh;
}

/** Applies a change to the saved order. Skipped before hydration so defaults never replace a saved order. */
export function updateMicrophoneOrder(
  change: (order: ReadonlyArray<MicrophoneEntry>) => ReadonlyArray<MicrophoneEntry>,
): ReadonlyArray<MicrophoneEntry> {
  const known = microphoneOrder(getClientSettings());
  if (!isClientSettingsHydrated()) return known;
  const next = change(known);
  if (next !== known) void updateClientSettings({ voiceMicrophones: [...next] });
  return next;
}

/** Remembers newly seen microphones and returns the device id to record from, empty for System default. */
export async function chooseRecordingMicrophone(): Promise<string> {
  // Rejects where the browser has no media devices, such as plain HTTP.
  const devices = await listAudioInputs().catch(() => []);
  return preferredMicrophoneId(
    updateMicrophoneOrder((order) => rememberMicrophones(order, devices)),
    devices,
  );
}
