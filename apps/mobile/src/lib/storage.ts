import * as Arr from "effect/Array";
import { pipe } from "effect/Function";
import * as SecureStore from "expo-secure-store";

import type { SavedRemoteConnection } from "./connection";

const CONNECTIONS_KEY = "t3code.connections";

async function readStorageItem(key: string): Promise<string | null> {
  return await SecureStore.getItemAsync(key);
}

async function writeStorageItem(key: string, value: string): Promise<void> {
  await SecureStore.setItemAsync(key, value);
}

export async function loadSavedConnections(): Promise<ReadonlyArray<SavedRemoteConnection>> {
  const raw = (await readStorageItem(CONNECTIONS_KEY)) ?? "";
  if (!raw.trim()) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as {
      readonly connections?: ReadonlyArray<SavedRemoteConnection>;
    };
    return pipe(
      parsed.connections ?? [],
      Arr.filter((c) => !!c.environmentId && !!c.bearerToken?.trim()),
    );
  } catch {
    return [];
  }
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

export async function clearSavedConnection(environmentId: string): Promise<void> {
  const current = await loadSavedConnections();
  const next = pipe(
    current,
    Arr.filter((entry) => entry.environmentId !== environmentId),
  );
  await writeStorageItem(CONNECTIONS_KEY, JSON.stringify({ connections: next }));
}
