import type { T3HostBridge, T3HostDisplayPreferences } from "@t3tools/contracts";
import { normalizeThreadConversationMaxWidth } from "@t3tools/shared/displayPreferences";
import { useSyncExternalStore } from "react";

import { isVscodeWebview } from "./env";

const DEFAULT_DISPLAY_PREFERENCES: T3HostDisplayPreferences = {
  showOpenInPicker: true,
  showCheckoutModeIndicator: true,
  showBranchSelector: true,
  enableTerminal: true,
  enableSourceControlPanel: true,
  threadConversationMaxWidthPx: null,
};

const VSCODE_DISPLAY_PREFERENCES: T3HostDisplayPreferences = {
  showOpenInPicker: false,
  showCheckoutModeIndicator: false,
  showBranchSelector: false,
  enableTerminal: false,
  enableSourceControlPanel: false,
  threadConversationMaxWidthPx: null,
};

export function resolveHostDisplayPreferences(input: {
  readonly isVscodeWebview: boolean;
  readonly preferences: Partial<T3HostDisplayPreferences> | null | undefined;
}): T3HostDisplayPreferences {
  const defaults = input.isVscodeWebview ? VSCODE_DISPLAY_PREFERENCES : DEFAULT_DISPLAY_PREFERENCES;
  const preferences = input.preferences;
  return {
    showOpenInPicker: preferences?.showOpenInPicker ?? defaults.showOpenInPicker,
    showCheckoutModeIndicator:
      preferences?.showCheckoutModeIndicator ?? defaults.showCheckoutModeIndicator,
    showBranchSelector: preferences?.showBranchSelector ?? defaults.showBranchSelector,
    enableTerminal: preferences?.enableTerminal ?? defaults.enableTerminal,
    enableSourceControlPanel:
      preferences?.enableSourceControlPanel ?? defaults.enableSourceControlPanel,
    threadConversationMaxWidthPx: normalizeThreadConversationMaxWidth(
      preferences?.threadConversationMaxWidthPx,
    ),
  };
}

function normalizeDisplayPreferences(
  preferences: Partial<T3HostDisplayPreferences> | null | undefined,
): T3HostDisplayPreferences {
  return resolveHostDisplayPreferences({ isVscodeWebview, preferences });
}

function areDisplayPreferencesEqual(
  left: T3HostDisplayPreferences,
  right: T3HostDisplayPreferences,
): boolean {
  return (
    left.showOpenInPicker === right.showOpenInPicker &&
    left.showCheckoutModeIndicator === right.showCheckoutModeIndicator &&
    left.showBranchSelector === right.showBranchSelector &&
    left.enableTerminal === right.enableTerminal &&
    left.enableSourceControlPanel === right.enableSourceControlPanel &&
    left.threadConversationMaxWidthPx === right.threadConversationMaxWidthPx
  );
}

let currentDisplayPreferences = normalizeDisplayPreferences(
  typeof window === "undefined" ? null : window.t3HostBridge?.getDisplayPreferences?.(),
);

const subscribers = new Set<() => void>();
let subscribedHostBridge: T3HostBridge | null = null;
let unsubscribeDisplayPreferences: (() => void) | null = null;

function setDisplayPreferences(
  nextPreferences: Partial<T3HostDisplayPreferences> | null | undefined,
): void {
  const normalizedPreferences = normalizeDisplayPreferences(nextPreferences);
  if (areDisplayPreferencesEqual(currentDisplayPreferences, normalizedPreferences)) {
    return;
  }

  currentDisplayPreferences = normalizedPreferences;
  for (const subscriber of subscribers) {
    subscriber();
  }
}

function emitDisplayPreferencesChanged(nextPreferences: T3HostDisplayPreferences): void {
  setDisplayPreferences(nextPreferences);
}

function ensureDisplayPreferencesBridgeSubscription(): void {
  if (typeof window === "undefined") {
    return;
  }

  const bridge = window.t3HostBridge ?? null;
  if (bridge === subscribedHostBridge) {
    return;
  }

  unsubscribeDisplayPreferences?.();
  subscribedHostBridge = bridge;
  unsubscribeDisplayPreferences = null;
  setDisplayPreferences(bridge?.getDisplayPreferences?.() ?? null);
  if (!bridge) {
    return;
  }

  unsubscribeDisplayPreferences =
    bridge.onDisplayPreferencesChanged?.(emitDisplayPreferencesChanged) ?? null;
}

if (typeof window !== "undefined") {
  ensureDisplayPreferencesBridgeSubscription();
}

export function subscribeHostDisplayPreferences(callback: () => void): () => void {
  ensureDisplayPreferencesBridgeSubscription();
  subscribers.add(callback);
  return () => {
    subscribers.delete(callback);
  };
}

export function readHostDisplayPreferences(): T3HostDisplayPreferences {
  ensureDisplayPreferencesBridgeSubscription();
  return currentDisplayPreferences;
}

export function useHostDisplayPreferences(): T3HostDisplayPreferences {
  return useSyncExternalStore(
    subscribeHostDisplayPreferences,
    readHostDisplayPreferences,
    readHostDisplayPreferences,
  );
}
