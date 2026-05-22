import * as Arr from "effect/Array";
import { pipe } from "effect/Function";
import * as SecureStore from "expo-secure-store";
import type { EnvironmentId, OrchestrationShellSnapshot } from "@t3tools/contracts";

import type { SavedRemoteConnection } from "./connection";

const CONNECTIONS_KEY = "t3code.connections";
const PREFERENCES_KEY = "t3code.preferences";
const SHELL_SNAPSHOT_CACHE_SCHEMA_VERSION = 1;
const SHELL_SNAPSHOT_CACHE_DIRECTORY = "shell-snapshots";

export interface CachedShellSnapshot {
  readonly schemaVersion: typeof SHELL_SNAPSHOT_CACHE_SCHEMA_VERSION;
  readonly environmentId: EnvironmentId;
  readonly snapshotReceivedAt: string;
  readonly snapshot: OrchestrationShellSnapshot;
}

export interface MobilePreferences {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isShellSnapshot(value: unknown): value is OrchestrationShellSnapshot {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.snapshotSequence === "number" &&
    Array.isArray(value.projects) &&
    Array.isArray(value.threads) &&
    typeof value.updatedAt === "string"
  );
}

function isCachedShellSnapshot(value: unknown): value is CachedShellSnapshot {
  if (!isRecord(value)) {
    return false;
  }
  return (
    value.schemaVersion === SHELL_SNAPSHOT_CACHE_SCHEMA_VERSION &&
    typeof value.environmentId === "string" &&
    typeof value.snapshotReceivedAt === "string" &&
    isShellSnapshot(value.snapshot)
  );
}

function cachedShellSnapshotFileName(environmentId: EnvironmentId): string {
  return `${encodeURIComponent(environmentId)}.json`;
}

async function getShellSnapshotCacheDirectory() {
  const { Directory, Paths } = await import("expo-file-system");
  const directory = new Directory(Paths.document, SHELL_SNAPSHOT_CACHE_DIRECTORY);
  directory.create({ idempotent: true, intermediates: true });
  return directory;
}

export async function loadCachedShellSnapshot(
  environmentId: EnvironmentId,
): Promise<CachedShellSnapshot | null> {
  try {
    const { File } = await import("expo-file-system");
    const directory = await getShellSnapshotCacheDirectory();
    const file = new File(directory, cachedShellSnapshotFileName(environmentId));
    if (!file.exists) {
      return null;
    }

    const parsed = JSON.parse(await file.text()) as unknown;
    if (!isCachedShellSnapshot(parsed) || parsed.environmentId !== environmentId) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

export async function saveCachedShellSnapshot(
  environmentId: EnvironmentId,
  snapshot: OrchestrationShellSnapshot,
): Promise<void> {
  try {
    const { File } = await import("expo-file-system");
    const directory = await getShellSnapshotCacheDirectory();
    const file = new File(directory, cachedShellSnapshotFileName(environmentId));
    const document: CachedShellSnapshot = {
      schemaVersion: SHELL_SNAPSHOT_CACHE_SCHEMA_VERSION,
      environmentId,
      snapshotReceivedAt: new Date().toISOString(),
      snapshot,
    };

    if (!file.exists) {
      file.create({ intermediates: true, overwrite: true });
    }
    file.write(JSON.stringify(document));
  } catch {
    // Cache persistence is best-effort and should never block live data.
  }
}

export async function clearCachedShellSnapshot(environmentId: EnvironmentId): Promise<void> {
  try {
    const { File } = await import("expo-file-system");
    const directory = await getShellSnapshotCacheDirectory();
    const file = new File(directory, cachedShellSnapshotFileName(environmentId));
    if (file.exists) {
      file.delete();
    }
  } catch {
    // Ignore cache cleanup failures.
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
    Arr.filter((c) => !!c.environmentId && !!c.bearerToken?.trim()),
  );
}

export async function saveConnection(connection: SavedRemoteConnection): Promise<void> {
  const current = await loadSavedConnections();
  const next = current.some((entry) => entry.environmentId === connection.environmentId)
    ? pipe(
        current,
        Arr.map((entry) => (entry.environmentId === connection.environmentId ? connection : entry)),
      )
    : pipe(current, Arr.append(connection));

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

export async function loadPreferences(): Promise<MobilePreferences> {
  const parsed = await readJsonStorageItem<MobilePreferences>(PREFERENCES_KEY);
  if (!parsed || typeof parsed !== "object") {
    return {};
  }

  if (typeof parsed.terminalFontSize === "number") {
    return { terminalFontSize: parsed.terminalFontSize };
  }

  return {};
}

export async function savePreferencesPatch(
  patch: Partial<MobilePreferences>,
): Promise<MobilePreferences> {
  const current = await loadPreferences();
  const next: MobilePreferences = {
    ...current,
    ...patch,
  };
  await writeStorageItem(PREFERENCES_KEY, JSON.stringify(next));
  return next;
}
