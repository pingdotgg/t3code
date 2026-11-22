import Constants from "expo-constants";
import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";

import { loadOrCreateAgentAwarenessDeviceId } from "../../persistence/imperative";
import {
  clearAndroidAgentNotifications,
  configureAndroidAgentNotifications,
} from "./androidNotifications";
import { UNIFIED_PUSH_USER_ID, type UnifiedPushState } from "./unifiedPush.logic";

interface UnifiedPushNative {
  unifiedPushState?(): UnifiedPushState | null;
  unifiedPushEnable?(): "registering" | "picking" | "none";
  unifiedPushDisable?(): void;
  addListener?(event: "onUnifiedPushState", listener: () => void): { remove(): void };
}

const native =
  Platform.OS === "android"
    ? requireOptionalNativeModule<UnifiedPushNative>("T3AgentNotifications")
    : null;

export function isUnifiedPushBuild(): boolean {
  return Platform.OS === "android" && Constants.expoConfig?.extra?.androidPush === "unifiedpush";
}

export function supportsUnifiedPush(): boolean {
  return typeof native?.unifiedPushEnable === "function";
}

let snapshot: UnifiedPushState | null = null;
let nativeSubscription: { remove(): void } | null = null;
const listeners = new Set<() => void>();

function refresh() {
  snapshot = native?.unifiedPushState?.() ?? null;
  for (const listener of listeners) listener();
}

export function subscribeUnifiedPushState(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    nativeSubscription = native?.addListener?.("onUnifiedPushState", refresh) ?? null;
    refresh();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      nativeSubscription?.remove();
      nativeSubscription = null;
    }
  };
}

export function getUnifiedPushState(): UnifiedPushState | null {
  return snapshot;
}

export async function enableUnifiedPush() {
  if (!native?.unifiedPushEnable) return "none";
  const deviceId = await loadOrCreateAgentAwarenessDeviceId();
  configureAndroidAgentNotifications(deviceId, UNIFIED_PUSH_USER_ID, true);
  return native.unifiedPushEnable();
}

export function disableUnifiedPush(): void {
  native?.unifiedPushDisable?.();
  clearAndroidAgentNotifications();
}
