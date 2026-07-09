import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import { pipe } from "effect/Function";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SecureStore from "expo-secure-store";
import { EnvironmentId } from "@t3tools/contracts";

import {
  isRelayManagedConnection,
  type SavedRemoteConnection,
  toStableSavedRemoteConnection,
} from "./connection";
import { MobileDatabase, mobileDatabaseRuntime } from "../persistence/mobile-database";

const CONNECTIONS_KEY = "t3code.connections";
const PREFERENCES_KEY = "t3code.preferences";
const AGENT_AWARENESS_DEVICE_ID_KEY = "t3code.agent-awareness.device-id";
const AGENT_AWARENESS_REGISTRATION_KEY = "t3code.agent-awareness.registration";
const MobileStorageKey = Schema.Literals([
  CONNECTIONS_KEY,
  PREFERENCES_KEY,
  AGENT_AWARENESS_DEVICE_ID_KEY,
  AGENT_AWARENESS_REGISTRATION_KEY,
]);
type MobileStorageKeyValue = typeof MobileStorageKey.Type;

export class MobileSecureStorageError extends Schema.TaggedErrorClass<MobileSecureStorageError>()(
  "MobileSecureStorageError",
  {
    operation: Schema.Literals(["read", "write", "delete", "generate-device-id"]),
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
  /** Cloud account ids that opted out of the T3 Connect onboarding sheet. */
  readonly connectOnboardingOptOutAccounts?: ReadonlyArray<string>;
  /** Home-screen project groups the user collapsed, by group key. */
  readonly collapsedProjectGroups?: readonly string[];
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

async function deleteStorageItem(key: MobileStorageKeyValue): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(key);
  } catch (cause) {
    throw new MobileSecureStorageError({ operation: "delete", key, cause });
  }
}

function parseJsonStorageItem<T>(key: MobileStorageKeyValue, raw: string): T | null {
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

async function readJsonStorageItem<T>(key: MobileStorageKeyValue): Promise<T | null> {
  const raw = (await readStorageItem(key)) ?? "";
  return parseJsonStorageItem<T>(key, raw);
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
  let databaseAvailable = true;
  const storedJson = await mobileDatabaseRuntime
    .runPromise(MobileDatabase.pipe(Effect.flatMap((database) => database.loadPreferencesJson)))
    .catch((cause) => {
      databaseAvailable = false;
      console.warn("[mobile-storage] database unavailable, using legacy preferences", cause);
      return Option.none<string>();
    });
  let parsed = Option.isSome(storedJson)
    ? parseJsonStorageItem<Preferences>(PREFERENCES_KEY, storedJson.value)
    : null;

  if (Option.isNone(storedJson)) {
    const legacyJson = await readStorageItem(PREFERENCES_KEY);
    parsed =
      legacyJson === null ? null : parseJsonStorageItem<Preferences>(PREFERENCES_KEY, legacyJson);
    if (parsed !== null && databaseAvailable) {
      await mobileDatabaseRuntime.runPromise(
        MobileDatabase.pipe(
          Effect.flatMap((database) => database.savePreferencesJson(JSON.stringify(parsed))),
        ),
      );
      await deleteStorageItem(PREFERENCES_KEY).catch((cause) => {
        console.warn("[mobile-storage] could not remove migrated preferences", cause);
      });
    }
  }

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
    connectOnboardingOptOutAccounts?: ReadonlyArray<string>;
    collapsedProjectGroups?: readonly string[];
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
  if (Array.isArray(parsed.connectOnboardingOptOutAccounts)) {
    preferences.connectOnboardingOptOutAccounts = parsed.connectOnboardingOptOutAccounts.filter(
      (account): account is string => typeof account === "string",
    );
  }
  if (Array.isArray(parsed.collapsedProjectGroups)) {
    preferences.collapsedProjectGroups = parsed.collapsedProjectGroups.filter(
      (key): key is string => typeof key === "string",
    );
  }

  return preferences;
}

// Preference writes are read-modify-write over one JSON blob; concurrent
// writers would drop each other's fields, so all writes are serialized here.
let preferencesWriteQueue: Promise<unknown> = Promise.resolve();

export async function updatePreferences(
  update: (current: Preferences) => Partial<Preferences>,
): Promise<Preferences> {
  const task = preferencesWriteQueue.then(async () => {
    const current = await loadPreferences();
    const next: Preferences = {
      ...current,
      ...update(current),
    };
    let encoded: string;
    try {
      encoded = JSON.stringify(next);
    } catch (cause) {
      throw new MobileStorageEncodeError({ key: PREFERENCES_KEY, cause });
    }
    await mobileDatabaseRuntime.runPromise(
      MobileDatabase.pipe(Effect.flatMap((database) => database.savePreferencesJson(encoded))),
    );
    return next;
  });
  preferencesWriteQueue = task.catch(() => undefined);
  return task;
}

export async function savePreferencesPatch(patch: Partial<Preferences>): Promise<Preferences> {
  return updatePreferences(() => patch);
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

export interface AgentAwarenessRegistrationRecord {
  readonly identity: string;
  readonly signature: string;
  // Last push-to-start token the relay accepted. Registrations triggered
  // without a token event merge it back in so token absence never reads as a
  // change (which would defeat the register-once skip every launch).
  readonly pushToStartToken?: string;
}

// Remembers the account identity and payload signature the relay last accepted
// so the app does not re-register on every launch while nothing has changed.
// Cleared only on sign-out.
export async function loadAgentAwarenessRegistrationRecord(): Promise<AgentAwarenessRegistrationRecord | null> {
  const parsed = await readJsonStorageItem<AgentAwarenessRegistrationRecord>(
    AGENT_AWARENESS_REGISTRATION_KEY,
  );
  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof parsed.identity !== "string" ||
    typeof parsed.signature !== "string"
  ) {
    return null;
  }
  return {
    identity: parsed.identity,
    signature: parsed.signature,
    ...(typeof parsed.pushToStartToken === "string" && parsed.pushToStartToken
      ? { pushToStartToken: parsed.pushToStartToken }
      : {}),
  };
}

export async function saveAgentAwarenessRegistrationRecord(
  record: AgentAwarenessRegistrationRecord,
): Promise<void> {
  await writeJsonStorageItem(AGENT_AWARENESS_REGISTRATION_KEY, record);
}

export async function clearAgentAwarenessRegistrationRecord(): Promise<void> {
  await writeStorageItem(AGENT_AWARENESS_REGISTRATION_KEY, "");
}
