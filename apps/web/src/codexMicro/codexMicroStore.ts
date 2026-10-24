import {
  DISCONNECTED_CODEX_MICRO_STATE,
  type CodexMicroDeviceState,
  type CodexMicroInputEvent,
} from "@t3tools/contracts";
import { useSyncExternalStore } from "react";

import { EMPTY_CODEX_MICRO_SLOTS, type CodexMicroSlot } from "./codexMicroSlots";

/**
 * Renderer-side Codex Micro state shared by the headless coordinator (which
 * owns slots and selection) and the settings page (which previews them).
 */
export interface CodexMicroSnapshot {
  /** False until the main process has reported the device state once. */
  readonly loaded: boolean;
  readonly device: CodexMicroDeviceState;
  readonly slots: ReadonlyArray<CodexMicroSlot>;
  readonly selectedSlot: number | null;
  readonly pressedKeys: ReadonlySet<string>;
  readonly joystick: { readonly angle: number; readonly distance: number };
}

let snapshot: CodexMicroSnapshot = {
  loaded: false,
  device: DISCONNECTED_CODEX_MICRO_STATE,
  slots: EMPTY_CODEX_MICRO_SLOTS,
  selectedSlot: null,
  pressedKeys: new Set(),
  joystick: { angle: 0, distance: 0 },
};
const listeners = new Set<() => void>();
const inputListeners = new Set<(input: CodexMicroInputEvent) => void>();
let unsubscribeBridge: (() => void) | null = null;

const bridge = () => (typeof window === "undefined" ? undefined : window.desktopBridge?.codexMicro);

function update(patch: Partial<CodexMicroSnapshot>) {
  snapshot = { ...snapshot, ...patch };
  for (const listener of listeners) listener();
}

function handleInput(input: CodexMicroInputEvent) {
  if (input.type === "joystick") {
    update({ joystick: { angle: input.angle, distance: input.distance } });
  } else if (input.act === 0 || input.act === 1) {
    const pressedKeys = new Set(snapshot.pressedKeys);
    if (input.act === 1) pressedKeys.add(input.key);
    else pressedKeys.delete(input.key);
    update({ pressedKeys });
  }
  for (const listener of inputListeners) listener(input);
}

function connectBridge() {
  const codexMicro = bridge();
  if (!codexMicro || unsubscribeBridge) return;
  unsubscribeBridge = codexMicro.onEvent((event) => {
    if (event.type === "state") {
      update({
        loaded: true,
        device: event.state,
        ...(event.state.connected ? {} : { pressedKeys: new Set<string>(), selectedSlot: null }),
      });
    } else {
      handleInput(event.input);
    }
  });
  void codexMicro.getState().then((device) => update({ loaded: true, device }));
}

function subscribe(listener: () => void) {
  connectBridge();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useCodexMicroSnapshot(): CodexMicroSnapshot {
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => snapshot,
  );
}

/** True while a Codex Micro is attached to this desktop app. */
export function useCodexMicroConnected(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => snapshot.device.connected,
    () => false,
  );
}

export function subscribeCodexMicroInput(listener: (input: CodexMicroInputEvent) => void) {
  connectBridge();
  inputListeners.add(listener);
  return () => inputListeners.delete(listener);
}

export function readCodexMicroSnapshot(): CodexMicroSnapshot {
  return snapshot;
}

export function setCodexMicroSlots(
  slots: ReadonlyArray<CodexMicroSlot>,
  selectedSlot: number | null,
) {
  if (slots === snapshot.slots && selectedSlot === snapshot.selectedSlot) return;
  update({ slots, selectedSlot });
}

export const isCodexMicroAvailable = () => bridge() !== undefined;
