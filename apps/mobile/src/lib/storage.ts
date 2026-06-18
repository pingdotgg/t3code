import * as Arr from "effect/Array";
import { pipe } from "effect/Function";
import * as SecureStore from "expo-secure-store";
import { EnvironmentId } from "@t3tools/contracts";

import {
  isRelayManagedConnection,
  type SavedRemoteConnection,
  toStableSavedRemoteConnection,
} from "./connection";

const CONNECTIONS_KEY = "t3code.connections";
const PREFERENCES_KEY = "t3code.preferences";
const AGENT_AWARENESS_DEVICE_ID_KEY = "t3code.agent-awareness.device-id";

export interface Preferences {
  readonly liveActivitiesEnabled?: boolean;
  readonly terminalFontSize?: number;
}

async function readStorageItem(key: string): Promise<string | null> {
  return await SecureStore.getItemAsync(key);
}

async function writeStorageItem(key: string, value: string): Promise<void> {
  await SecureStore.setItemAsync(key, value);
}

async function readJsonStorageItem<T>(key: string): Promise<T | null> {
  const raw = (await readStorageItem(key)) ?? "";
  if (!raw.trim()) {
    return null;
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function loadSavedConnections(): Promise<ReadonlyArray<SavedRemoteConnection>> {
  const parsed = await readJsonStorageItem<{
    readonly connections?: ReadonlyArray<SavedRemoteConnection>;
  }>(CONNECTIONS_KEY);
  if (!parsed) {
    return [];
  }

  return pipe(
    parsed.connections ?? [],
    Arr.filter(
      (c) => !!c.environmentId && (!!c.bearerToken?.trim() || isRelayManagedConnection(c)),
    ),
  );
}

export async function saveConnection(connection: SavedRemoteConnection): Promise<void> {
  const current = await loadSavedConnections();
  const stableConnection = toStableSavedRemoteConnection(connection);
  const next = current.some((entry) => entry.environmentId === connection.environmentId)
    ? pipe(
        current,
        Arr.map((entry) =>
          entry.environmentId === connection.environmentId ? stableConnection : entry,
        ),
      )
    : pipe(current, Arr.append(stableConnection));

  await writeStorageItem(CONNECTIONS_KEY, JSON.stringify({ connections: next }));
}

export async function clearSavedConnection(environmentId: EnvironmentId): Promise<void> {
  const current = await loadSavedConnections();
  const next = pipe(
    current,
    Arr.filter((entry) => entry.environmentId !== environmentId),
  );
  await writeStorageItem(CONNECTIONS_KEY, JSON.stringify({ connections: next }));
}

export async function loadPreferences(): Promise<Preferences> {
  const parsed = await readJsonStorageItem<Preferences>(PREFERENCES_KEY);
  if (!parsed || typeof parsed !== "object") {
    return {};
  }

  const preferences: {
    liveActivitiesEnabled?: boolean;
    terminalFontSize?: number;
  } = {};

  if (typeof parsed.liveActivitiesEnabled === "boolean") {
    preferences.liveActivitiesEnabled = parsed.liveActivitiesEnabled;
  }
  if (typeof parsed.terminalFontSize === "number") {
    preferences.terminalFontSize = parsed.terminalFontSize;
  }

  return preferences;
}

export async function savePreferencesPatch(patch: Partial<Preferences>): Promise<Preferences> {
  const current = await loadPreferences();
  const next: Preferences = {
    ...current,
    ...patch,
  };
  await writeStorageItem(PREFERENCES_KEY, JSON.stringify(next));
  return next;
}

export async function loadOrCreateAgentAwarenessDeviceId(): Promise<string> {
  const existing = await readStorageItem(AGENT_AWARENESS_DEVICE_ID_KEY);
  if (existing?.trim()) {
    return existing;
  }

  const { uuidv4 } = await import("./uuid");
  const deviceId = uuidv4();
  await writeStorageItem(AGENT_AWARENESS_DEVICE_ID_KEY, deviceId);
  return deviceId;
}

export async function loadAgentAwarenessDeviceId(): Promise<string | null> {
  const existing = await readStorageItem(AGENT_AWARENESS_DEVICE_ID_KEY);
  return existing?.trim() ? existing : null;
}
