import { Platform } from "react-native";

import type { RemoteConnectionInput } from "./connection";

const CONNECTION_URL_KEY = "t3remote:server-url";
const CONNECTION_TOKEN_KEY = "t3remote:server-token";
const memoryStorage = new Map<string, string>();

type AsyncStorageModule = typeof import("@react-native-async-storage/async-storage");
type AsyncStorageLike = Pick<AsyncStorageModule["default"], "getItem" | "setItem" | "removeItem">;
type SecureStoreModule = typeof import("expo-secure-store");

let asyncStoragePromise: Promise<AsyncStorageLike | null> | null = null;
let secureStorePromise: Promise<SecureStoreModule | null> | null = null;

async function loadAsyncStorage(): Promise<AsyncStorageLike | null> {
  if (!asyncStoragePromise) {
    asyncStoragePromise = import("@react-native-async-storage/async-storage")
      .then((module) => module.default)
      .catch(() => null);
  }

  return await asyncStoragePromise;
}

async function loadSecureStore(): Promise<SecureStoreModule | null> {
  if (Platform.OS === "web") {
    return null;
  }

  if (!secureStorePromise) {
    secureStorePromise = import("expo-secure-store").catch(() => null);
  }

  return await secureStorePromise;
}

async function readFallbackItem(key: string): Promise<string | null> {
  return memoryStorage.get(key) ?? null;
}

async function writeFallbackItem(key: string, value: string): Promise<void> {
  memoryStorage.set(key, value);
}

async function removeFallbackItem(key: string): Promise<void> {
  memoryStorage.delete(key);
}

async function readStorageItem(key: string): Promise<string | null> {
  const asyncStorage = await loadAsyncStorage();
  if (!asyncStorage) {
    return await readFallbackItem(key);
  }

  try {
    return await asyncStorage.getItem(key);
  } catch {
    return await readFallbackItem(key);
  }
}

async function writeStorageItem(key: string, value: string): Promise<void> {
  const asyncStorage = await loadAsyncStorage();
  if (!asyncStorage) {
    await writeFallbackItem(key, value);
    return;
  }

  try {
    await asyncStorage.setItem(key, value);
  } catch {
    await writeFallbackItem(key, value);
  }
}

async function removeStorageItem(key: string): Promise<void> {
  const asyncStorage = await loadAsyncStorage();
  if (!asyncStorage) {
    await removeFallbackItem(key);
    return;
  }

  try {
    await asyncStorage.removeItem(key);
  } catch {
    await removeFallbackItem(key);
  }
}

async function loadToken(): Promise<string> {
  if (Platform.OS === "web") {
    return (await readStorageItem(CONNECTION_TOKEN_KEY)) ?? "";
  }

  const secureStore = await loadSecureStore();
  try {
    if (secureStore) {
      return (await secureStore.getItemAsync(CONNECTION_TOKEN_KEY)) ?? "";
    }
  } catch {
    // fall through to async storage
  }
  return (await readStorageItem(CONNECTION_TOKEN_KEY)) ?? "";
}

async function storeToken(token: string): Promise<void> {
  if (token.trim().length === 0) {
    if (Platform.OS === "web") {
      await removeStorageItem(CONNECTION_TOKEN_KEY);
      return;
    }

    const secureStore = await loadSecureStore();
    try {
      await secureStore?.deleteItemAsync(CONNECTION_TOKEN_KEY);
    } catch {
      // Ignore secure store cleanup failures and clear fallback storage.
    }
    await removeStorageItem(CONNECTION_TOKEN_KEY);
    return;
  }

  if (Platform.OS === "web") {
    await writeStorageItem(CONNECTION_TOKEN_KEY, token);
    return;
  }

  const secureStore = await loadSecureStore();
  try {
    if (secureStore) {
      await secureStore.setItemAsync(CONNECTION_TOKEN_KEY, token);
      return;
    }
  } catch {
    // Fall through to async storage fallback.
  }

  await writeStorageItem(CONNECTION_TOKEN_KEY, token);
}

export async function loadSavedConnectionInput(): Promise<RemoteConnectionInput | null> {
  const serverUrl = (await readStorageItem(CONNECTION_URL_KEY))?.trim() ?? "";
  if (serverUrl.length === 0) {
    return null;
  }

  return {
    serverUrl,
    authToken: await loadToken(),
  };
}

export async function saveConnectionInput(input: RemoteConnectionInput): Promise<void> {
  await writeStorageItem(CONNECTION_URL_KEY, input.serverUrl.trim());
  await storeToken(input.authToken.trim());
}

export async function clearSavedConnectionInput(): Promise<void> {
  await removeStorageItem(CONNECTION_URL_KEY);
  await storeToken("");
}
