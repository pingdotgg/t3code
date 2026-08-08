import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";

const MODULE_NAME = "T3AgentLiveUpdate";

export interface AndroidLiveUpdateStatus {
  readonly apiLevel: number;
  readonly supportsPromotion: boolean;
  readonly notificationsEnabled: boolean;
  readonly canPostPromotedNotifications: boolean;
  readonly channelImportance: number;
  readonly active: boolean;
  readonly promotable: boolean;
  readonly promoted: boolean;
}

interface AndroidLiveUpdateSnapshot {
  readonly title: string;
  readonly summary: string;
  readonly lines: ReadonlyArray<string>;
  readonly shortCriticalText: string;
}

interface AndroidLiveUpdateNativeModule {
  readonly ensureChannel: () => Promise<AndroidLiveUpdateStatus>;
  readonly getStatus: () => Promise<AndroidLiveUpdateStatus>;
  readonly show: (snapshot: AndroidLiveUpdateSnapshot) => Promise<AndroidLiveUpdateStatus>;
  readonly cancel: () => Promise<AndroidLiveUpdateStatus>;
  readonly openPromotionSettings: () => Promise<AndroidLiveUpdateStatus>;
}

export type AndroidLiveUpdateMockKind = "working" | "attention";

const MOCK_SNAPSHOTS: Record<AndroidLiveUpdateMockKind, AndroidLiveUpdateSnapshot> = {
  working: {
    title: "3 agents working",
    summary: "T3 Code is making progress",
    lines: [
      "● Implementing Android Live Updates",
      "● Running the mobile typecheck",
      "◌ Reviewing recent agent changes",
    ],
    shortCriticalText: "3",
  },
  attention: {
    title: "1 agent needs attention",
    summary: "Approval is required to continue",
    lines: [
      "! Waiting for your approval",
      "● Android validation is still running",
      "● Two agents continue in the background",
    ],
    shortCriticalText: "Action",
  },
};

function resolveNativeModule(): AndroidLiveUpdateNativeModule | null {
  if (Platform.OS !== "android") return null;
  try {
    return requireOptionalNativeModule<AndroidLiveUpdateNativeModule>(MODULE_NAME);
  } catch {
    return null;
  }
}

function requireNativeLiveUpdateModule(): AndroidLiveUpdateNativeModule {
  const module = resolveNativeModule();
  if (module) return module;
  throw new Error("Rebuild the Android development client to install the Live Update module.");
}

export function hasAndroidLiveUpdateModule(): boolean {
  return resolveNativeModule() !== null;
}

export async function ensureAndroidLiveUpdateChannel(): Promise<AndroidLiveUpdateStatus> {
  return requireNativeLiveUpdateModule().ensureChannel();
}

export async function getAndroidLiveUpdateStatus(): Promise<AndroidLiveUpdateStatus | null> {
  return resolveNativeModule()?.getStatus() ?? null;
}

export async function showAndroidLiveUpdateMock(
  kind: AndroidLiveUpdateMockKind,
): Promise<AndroidLiveUpdateStatus> {
  return requireNativeLiveUpdateModule().show(MOCK_SNAPSHOTS[kind]);
}

export async function cancelAndroidLiveUpdateMock(): Promise<AndroidLiveUpdateStatus> {
  return requireNativeLiveUpdateModule().cancel();
}

export async function openAndroidLiveUpdatePromotionSettings(): Promise<AndroidLiveUpdateStatus> {
  return requireNativeLiveUpdateModule().openPromotionSettings();
}
