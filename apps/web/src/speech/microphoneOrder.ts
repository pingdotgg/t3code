import type { ClientSettings, VoiceMicrophoneEntry } from "@t3tools/contracts";

import type { BrowserMicrophone } from "./browserMicrophones";

export type MicrophoneEntry = VoiceMicrophoneEntry;

const SYSTEM_DEFAULT: MicrophoneEntry = { kind: "default" };

// Chromium lists the current default and Windows communications device under these ids too.
const ALIAS_DEVICE_IDS = new Set(["", "default", "communications"]);

/** True for ids that stand for the system default, including the id-less input shown before permission. */
export function isSystemDefaultDeviceId(deviceId: string): boolean {
  return ALIAS_DEVICE_IDS.has(deviceId);
}

export function microphoneEntryKey(entry: MicrophoneEntry): string {
  return entry.kind === "default" ? "default" : `device:${entry.deviceId}`;
}

/** The saved order with exactly one System default row; an empty order starts from the legacy choice. */
export function microphoneOrder(
  settings: Pick<ClientSettings, "voiceMicrophones" | "voiceMicrophone">,
): ReadonlyArray<MicrophoneEntry> {
  if (settings.voiceMicrophones.length === 0) {
    return settings.voiceMicrophone
      ? [{ kind: "device", deviceId: settings.voiceMicrophone, label: "" }, SYSTEM_DEFAULT]
      : [SYSTEM_DEFAULT];
  }
  const keys = new Set<string>();
  const order = settings.voiceMicrophones.filter((entry) => {
    const key = microphoneEntryKey(entry);
    if (keys.has(key)) return false;
    keys.add(key);
    return true;
  });
  return keys.has("default") ? order : [...order, SYSTEM_DEFAULT];
}

/** Adds labelled devices seen for the first time directly below System default and refreshes labels. */
export function rememberMicrophones(
  order: ReadonlyArray<MicrophoneEntry>,
  devices: ReadonlyArray<BrowserMicrophone>,
): ReadonlyArray<MicrophoneEntry> {
  let next: MicrophoneEntry[] | null = null;
  let insertAt = order.findIndex((entry) => entry.kind === "default") + 1;
  for (const device of devices) {
    if (!device.label || ALIAS_DEVICE_IDS.has(device.deviceId)) continue;
    const current: ReadonlyArray<MicrophoneEntry> = next ?? order;
    const index = current.findIndex(
      (entry) => entry.kind === "device" && entry.deviceId === device.deviceId,
    );
    const existing = current[index];
    if (existing?.kind === "device" && existing.label === device.label) continue;
    next ??= [...order];
    const entry: MicrophoneEntry = {
      kind: "device",
      deviceId: device.deviceId,
      label: device.label,
    };
    if (index !== -1) {
      next[index] = entry;
      continue;
    }
    next.splice(insertAt, 0, entry);
    insertAt += 1;
  }
  return next ?? order;
}

/**
 * The first entry that is connected right now. System default always is. Before microphone
 * permission the browser hides device ids, so the first entry is used as it was saved.
 */
export function preferredMicrophone(
  order: ReadonlyArray<MicrophoneEntry>,
  devices: ReadonlyArray<BrowserMicrophone>,
): MicrophoneEntry {
  if (devices.every((device) => !device.deviceId)) return order[0] ?? SYSTEM_DEFAULT;
  return (
    order.find(
      (entry) =>
        entry.kind === "default" || devices.some((device) => device.deviceId === entry.deviceId),
    ) ?? SYSTEM_DEFAULT
  );
}

/** The `deviceId` to record from, or an empty string for System default. */
export function preferredMicrophoneId(
  order: ReadonlyArray<MicrophoneEntry>,
  devices: ReadonlyArray<BrowserMicrophone>,
): string {
  const entry = preferredMicrophone(order, devices);
  return entry.kind === "device" ? entry.deviceId : "";
}

export function moveMicrophone(
  order: ReadonlyArray<MicrophoneEntry>,
  key: string,
  steps: number,
): ReadonlyArray<MicrophoneEntry> {
  const from = order.findIndex((entry) => microphoneEntryKey(entry) === key);
  const to = Math.max(0, Math.min(order.length - 1, from + steps));
  if (from === -1 || from === to) return order;
  const next = [...order];
  const [entry] = next.splice(from, 1);
  if (!entry) return order;
  next.splice(to, 0, entry);
  return next;
}

/** Moves an entry to the top, adding it when it is not listed yet. */
export function preferMicrophone(
  order: ReadonlyArray<MicrophoneEntry>,
  entry: MicrophoneEntry,
): ReadonlyArray<MicrophoneEntry> {
  const key = microphoneEntryKey(entry);
  const existing = order.find((candidate) => microphoneEntryKey(candidate) === key);
  return [existing ?? entry, ...order.filter((candidate) => microphoneEntryKey(candidate) !== key)];
}

/** Removes a named microphone. System default stays. */
export function forgetMicrophone(
  order: ReadonlyArray<MicrophoneEntry>,
  key: string,
): ReadonlyArray<MicrophoneEntry> {
  return key === "default" ? order : order.filter((entry) => microphoneEntryKey(entry) !== key);
}
