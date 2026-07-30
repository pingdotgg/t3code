import * as Arr from "effect/Array";
import { pipe } from "effect/Function";
import * as Schema from "effect/Schema";
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
const MobileStorageKey = Schema.Literals([
  CONNECTIONS_KEY,
  PREFERENCES_KEY,
  AGENT_AWARENESS_DEVICE_ID_KEY,
]);
type MobileStorageKeyValue = typeof MobileStorageKey.Type;

export class MobileSecureStorageError extends Schema.TaggedErrorClass<MobileSecureStorageError>()(
  "MobileSecureStorageError",
  {
    operation: Schema.Literals(["read", "write", "generate-device-id"]),
    key: MobileStorageKey,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Mobile secure storage operation ${this.operation} failed for key ${this.key}.`;
  }
}

export class MobileStorageDecodeError extends Schema.TaggedErrorClass<MobileStorageDecodeError>()(
  "MobileStorageDecodeError",
  {
    key: MobileStorageKey,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to decode mobile storage value for key ${this.key}.`;
  }
}

export class MobileStorageEncodeError extends Schema.TaggedErrorClass<MobileStorageEncodeError>()(
  "MobileStorageEncodeError",
  {
    key: MobileStorageKey,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to encode mobile storage value for key ${this.key}.`;
  }
}

export interface Preferences {
  readonly liveActivitiesEnabled?: boolean;
  readonly baseFontSize?: number;
  /** Terminal font size override; null/absent means derived from baseFontSize. */
  readonly terminalFontSize?: number | null;
  /** Legacy key predating baseFontSize; read once for migration. */
  readonly markdownFontSize?: number;
  /** Code/diff font size override; null/absent means derived from baseFontSize. */
  readonly codeFontSize?: number | null;
  readonly codeWordBreak?: boolean;
}

async function readStorageItem(key: MobileStorageKeyValue): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(key);
  } catch (cause) {
    throw new MobileSecureStorageError({ operation: "read", key, cause });
  }
}

async function writeStorageItem(key: MobileStorageKeyValue, value: string): Promise<void> {
  try {
    await SecureStore.setItemAsync(key, value);
  } catch (cause) {
    throw new MobileSecureStorageError({ operation: "write", key, cause });
  }
}

async function readJsonStorageItem<T>(key: MobileStorageKeyValue): Promise<T | null> {
  const raw = (await readStorageItem(key)) ?? "";
  if (!raw.trim()) {
    return null;
  }

  try {
    return JSON.parse(raw) as T;
  } catch (cause) {
    console.warn(
      "[mobile-storage] ignored invalid JSON",
      new MobileStorageDecodeError({ key, cause }),
    );
    return null;
  }
}

async function writeJsonStorageItem(key: MobileStorageKeyValue, value: unknown) {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch (cause) {
    throw new MobileStorageEncodeError({ key, cause });
  }
  await writeStorageItem(key, encoded);
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

  await writeJsonStorageItem(CONNECTIONS_KEY, { connections: next });
}

export async function clearSavedConnection(environmentId: EnvironmentId): Promise<void> {
  const current = await loadSavedConnections();
  const next = pipe(
    current,
    Arr.filter((entry) => entry.environmentId !== environmentId),
  );
  await writeJsonStorageItem(CONNECTIONS_KEY, { connections: next });
}

export async function loadPreferences(): Promise<Preferences> {
  const parsed = await readJsonStorageItem<Preferences>(PREFERENCES_KEY);
  if (!parsed || typeof parsed !== "object") {
    return {};
  }

  const preferences: {
    liveActivitiesEnabled?: boolean;
    baseFontSize?: number;
    terminalFontSize?: number | null;
    markdownFontSize?: number;
    codeFontSize?: number | null;
    codeWordBreak?: boolean;
  } = {};

  if (typeof parsed.liveActivitiesEnabled === "boolean") {
    preferences.liveActivitiesEnabled = parsed.liveActivitiesEnabled;
  }
  if (typeof parsed.baseFontSize === "number") {
    preferences.baseFontSize = parsed.baseFontSize;
  }
  if (typeof parsed.terminalFontSize === "number" || parsed.terminalFontSize === null) {
    preferences.terminalFontSize = parsed.terminalFontSize;
  }
  if (typeof parsed.markdownFontSize === "number") {
    preferences.markdownFontSize = parsed.markdownFontSize;
  }
  if (typeof parsed.codeFontSize === "number" || parsed.codeFontSize === null) {
    preferences.codeFontSize = parsed.codeFontSize;
  }
  if (typeof parsed.codeWordBreak === "boolean") {
    preferences.codeWordBreak = parsed.codeWordBreak;
  }

  return preferences;
}

export async function savePreferencesPatch(patch: Partial<Preferences>): Promise<Preferences> {
  const current = await loadPreferences();
  const next: Preferences = {
    ...current,
    ...patch,
  };
  await writeJsonStorageItem(PREFERENCES_KEY, next);
  return next;
}

export async function loadOrCreateAgentAwarenessDeviceId(): Promise<string> {
  const existing = await readStorageItem(AGENT_AWARENESS_DEVICE_ID_KEY);
  if (existing?.trim()) {
    return existing;
  }

  const deviceId = await import("./uuid")
    .then(({ uuidv4 }) => uuidv4())
    .catch((cause) => {
      throw new MobileSecureStorageError({
        operation: "generate-device-id",
        key: AGENT_AWARENESS_DEVICE_ID_KEY,
        cause,
      });
    });
  await writeStorageItem(AGENT_AWARENESS_DEVICE_ID_KEY, deviceId);
  return deviceId;
}

export async function loadAgentAwarenessDeviceId(): Promise<string | null> {
  const existing = await readStorageItem(AGENT_AWARENESS_DEVICE_ID_KEY);
  return existing?.trim() ? existing : null;
}
