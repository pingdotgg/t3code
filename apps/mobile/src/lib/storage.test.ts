import { EnvironmentId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { removeImportedMobileTheme } from "./mobileTheme";
import { parseMobileThemeFile } from "./mobileThemeFile";

const mocks = vi.hoisted(() => {
  const values = new Map<string, string>();
  let preferencesJson: string | null = null;
  let preferencesUpdatedAt = 0;
  let loadPreferencesFails = false;
  let savePreferencesFails = false;
  return {
    clear: () => {
      values.clear();
      preferencesJson = null;
      preferencesUpdatedAt = 0;
      loadPreferencesFails = false;
      savePreferencesFails = false;
    },
    getStoredValue: (key: string) => values.get(key) ?? null,
    getPreferencesJson: () => preferencesJson,
    setPreferencesJson: (value: string, updatedAt: number) => {
      preferencesJson = value;
      preferencesUpdatedAt = updatedAt;
    },
    setDatabaseFailures: (load: boolean, save: boolean) => {
      loadPreferencesFails = load;
      savePreferencesFails = save;
    },
    getItemAsync: vi.fn((key: string) => Promise.resolve(values.get(key) ?? null)),
    setItemAsync: vi.fn((key: string, value: string) => {
      values.set(key, value);
      return Promise.resolve();
    }),
    deleteItemAsync: vi.fn((key: string) => {
      values.delete(key);
      return Promise.resolve();
    }),
    database: {
      closeAsync: vi.fn(() => Promise.resolve()),
      execAsync: vi.fn(() => Promise.resolve()),
      withExclusiveTransactionAsync: vi.fn(
        (run: (transaction: { execAsync: () => Promise<void> }) => Promise<void>) =>
          run({ execAsync: () => Promise.resolve() }),
      ),
      getFirstAsync: vi.fn((sql: string) => {
        if (sql.includes("PRAGMA user_version")) {
          return Promise.resolve({ user_version: 1 });
        }
        if (loadPreferencesFails) {
          return Promise.reject(new Error("database unavailable"));
        }
        return Promise.resolve(
          preferencesJson === null
            ? null
            : { payload: preferencesJson, updatedAt: preferencesUpdatedAt },
        );
      }),
      runAsync: vi.fn((_sql: string, payload?: unknown, updatedAt?: unknown) => {
        if (savePreferencesFails) {
          return Promise.reject(new Error("database unavailable"));
        }
        if (typeof payload === "string") {
          preferencesJson = payload;
        }
        if (typeof updatedAt === "number") {
          preferencesUpdatedAt = updatedAt;
        }
        return Promise.resolve();
      }),
    },
  };
});

vi.mock("expo-secure-store", () => ({
  deleteItemAsync: mocks.deleteItemAsync,
  getItemAsync: mocks.getItemAsync,
  setItemAsync: mocks.setItemAsync,
}));

vi.mock("expo-sqlite", () => ({
  openDatabaseAsync: vi.fn(() => Promise.resolve(mocks.database)),
}));

vi.mock("expo-crypto", () => ({
  getRandomBytes: vi.fn(() => new Uint8Array(16)),
}));

vi.mock("expo-constants", () => ({
  default: { expoConfig: { extra: {} } },
}));

vi.mock("react-native", () => ({
  Platform: {
    OS: "ios",
  },
}));

import {
  loadPreferences,
  loadSavedConnections,
  saveConnection,
  savePreferencesPatch,
} from "../persistence/imperative";
import { toStableSavedRemoteConnection } from "./connection";

const managedConnection = {
  environmentId: EnvironmentId.make("environment-1"),
  environmentLabel: "Desktop",
  pairingUrl: "https://desktop.example/",
  displayUrl: "https://desktop.example/",
  httpBaseUrl: "https://desktop.example/",
  wsBaseUrl: "wss://desktop.example/",
  bearerToken: null,
  authenticationMethod: "dpop",
  dpopAccessToken: "short-lived-token",
  relayManaged: true,
} as const;

describe("mobile connection storage", () => {
  beforeEach(() => {
    mocks.clear();
    vi.clearAllMocks();
  });

  it("persists relay-managed connections without their ephemeral access token", async () => {
    await saveConnection(managedConnection);

    const savedValue = mocks.setItemAsync.mock.calls[0]?.[1];
    expect(savedValue).toBeDefined();
    expect(JSON.parse(savedValue ?? "")).toEqual({
      connections: [toStableSavedRemoteConnection(managedConnection)],
    });
  });

  it("loads relay-managed connection metadata without a cached access token", async () => {
    await saveConnection(managedConnection);

    await expect(loadSavedConnections()).resolves.toEqual([
      toStableSavedRemoteConnection(managedConnection),
    ]);
  });

  it("preserves secure-storage read failures with operation and key context", async () => {
    const cause = new Error("keychain unavailable");
    mocks.getItemAsync.mockRejectedValueOnce(cause);

    await expect(loadSavedConnections()).rejects.toMatchObject({
      _tag: "MobileSecureStorageError",
      operation: "read",
      key: "t3code.connections",
      cause,
      message: "Mobile secure storage operation read failed for key t3code.connections.",
    });
  });

  it("logs structured decode failures before using the empty fallback", async () => {
    await mocks.setItemAsync("t3code.connections", "{");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(loadSavedConnections()).resolves.toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      "[mobile-storage] ignored invalid JSON",
      expect.objectContaining({
        _tag: "MobileStorageDecodeError",
        key: "t3code.connections",
        cause: expect.any(SyntaxError),
        message: "Failed to decode mobile storage value for key t3code.connections.",
      }),
    );

    warn.mockRestore();
  });

  it("loads legacy preferences when SQLite is unavailable", async () => {
    mocks.setDatabaseFailures(true, true);
    await mocks.setItemAsync(
      "t3code.preferences",
      JSON.stringify({ baseFontSize: 17, planModeEnabled: true }),
    );

    await expect(loadPreferences()).resolves.toEqual({ baseFontSize: 17, planModeEnabled: true });
  });

  it("drops non-canonical synced preference stamps used for lexical LWW ordering", async () => {
    mocks.setPreferencesJson(
      JSON.stringify({
        planModeEnabled: true,
        syncedClientPreferencesUpdatedAt: "2026-08-14T12:00:00Z",
      }),
      10,
    );

    await expect(loadPreferences()).resolves.toEqual({ planModeEnabled: true });
  });

  it("loads per-field synced preference stamps and legacy aggregate stamps", async () => {
    mocks.setPreferencesJson(
      JSON.stringify({
        planModeEnabled: true,
        syncedClientPreferencesUpdatedAtByField: {
          planModeEnabled: "2026-08-14T12:00:00.000Z",
        },
        syncedClientPreferencesUpdatedAt: "2026-08-14T11:00:00.000Z",
      }),
      10,
    );

    await expect(loadPreferences()).resolves.toMatchObject({
      syncedClientPreferencesUpdatedAtByField: {
        planModeEnabled: "2026-08-14T12:00:00.000Z",
      },
      syncedClientPreferencesUpdatedAt: "2026-08-14T11:00:00.000Z",
    });
  });

  it("preserves unrelated field stamps when saving a partial stamp map", async () => {
    mocks.setPreferencesJson(
      JSON.stringify({
        syncedClientPreferencesUpdatedAtByField: {
          appearanceMode: "2026-08-14T13:00:00.000Z",
        },
      }),
      10,
    );

    await expect(
      savePreferencesPatch({
        syncedClientPreferencesUpdatedAtByField: {
          planModeEnabled: "2026-08-14T12:00:00.000Z",
        },
      }),
    ).resolves.toMatchObject({
      syncedClientPreferencesUpdatedAtByField: {
        planModeEnabled: "2026-08-14T12:00:00.000Z",
        appearanceMode: "2026-08-14T13:00:00.000Z",
      },
    });
  });

  it("persists device-local appearance preferences", async () => {
    await expect(
      savePreferencesPatch({ appearanceMode: "dark", themeId: "ocean" }),
    ).resolves.toEqual({ appearanceMode: "dark", themeId: "ocean" });

    await expect(loadPreferences()).resolves.toEqual({
      appearanceMode: "dark",
      themeId: "ocean",
    });

    await expect(savePreferencesPatch({ appearanceMode: "system" })).resolves.toEqual({
      appearanceMode: "system",
      themeId: "ocean",
    });
    await expect(loadPreferences()).resolves.toEqual({
      appearanceMode: "system",
      themeId: "ocean",
    });
  });

  it("drops invalid appearance preferences while loading", async () => {
    mocks.setPreferencesJson(
      JSON.stringify({ appearanceMode: "sepia", themeId: "custom-theme" }),
      10,
    );

    await expect(loadPreferences()).resolves.toEqual({});
  });

  it("round-trips validated imported themes and their selection", async () => {
    const importedTheme = parseMobileThemeFile({
      version: 1,
      id: "northern-lights",
      name: "Northern Lights",
      appearance: "dark",
      colors: { canvas: "#0f172a", text: "#f8fafc", accent: "#60a5fa" },
    });

    await expect(
      savePreferencesPatch({ importedThemes: [importedTheme], themeId: importedTheme.id }),
    ).resolves.toEqual({ importedThemes: [importedTheme], themeId: importedTheme.id });
    await expect(loadPreferences()).resolves.toEqual({
      importedThemes: [importedTheme],
      themeId: importedTheme.id,
    });
  });

  it("persists the default fallback when removing a selected imported theme", async () => {
    const importedTheme = parseMobileThemeFile({
      version: 1,
      id: "northern-lights",
      name: "Northern Lights",
      appearance: "dark",
      colors: { canvas: "#0f172a" },
    });
    await savePreferencesPatch({ importedThemes: [importedTheme], themeId: importedTheme.id });
    const patch = removeImportedMobileTheme([importedTheme], importedTheme.id, importedTheme.id);
    if (!patch) throw new Error("Expected the imported theme to be removed");

    await savePreferencesPatch(patch);

    await expect(loadPreferences()).resolves.toEqual({ themeId: "t3-code" });
  });

  it("preserves the selection when removing a different imported theme", async () => {
    const first = parseMobileThemeFile({
      version: 1,
      id: "first-theme",
      name: "First Theme",
      appearance: "light",
      colors: { canvas: "#ffffff" },
    });
    const second = parseMobileThemeFile({
      version: 1,
      id: "second-theme",
      name: "Second Theme",
      appearance: "dark",
      colors: { canvas: "#000000" },
    });
    await savePreferencesPatch({ importedThemes: [first, second], themeId: second.id });
    const patch = removeImportedMobileTheme([first, second], first.id, second.id);
    if (!patch) throw new Error("Expected the imported theme to be removed");

    await savePreferencesPatch(patch);

    await expect(loadPreferences()).resolves.toEqual({
      importedThemes: [second],
      themeId: second.id,
    });
  });

  it("drops a corrupt imported-theme library and its stale selection", async () => {
    mocks.setPreferencesJson(
      JSON.stringify({ importedThemes: { invalid: true }, themeId: "northern-lights" }),
      10,
    );

    await expect(loadPreferences()).resolves.toEqual({});
  });

  it("falls back to secure storage when SQLite cannot save preferences", async () => {
    mocks.setDatabaseFailures(true, true);
    await expect(savePreferencesPatch({ baseFontSize: 19 })).resolves.toEqual({ baseFontSize: 19 });
    const fallback = JSON.parse(mocks.getStoredValue("t3code.preferences.fallback") ?? "") as {
      readonly payload: string;
      readonly updatedAt: number;
    };
    expect(JSON.parse(fallback.payload)).toEqual({ baseFontSize: 19 });
    expect(fallback.updatedAt).toEqual(expect.any(Number));
  });

  it("reconciles fallback preferences after SQLite recovers", async () => {
    mocks.setPreferencesJson(JSON.stringify({ baseFontSize: 15 }), 10);
    await mocks.setItemAsync(
      "t3code.preferences.fallback",
      JSON.stringify({
        payload: JSON.stringify({ baseFontSize: 19 }),
        updatedAt: 20,
      }),
    );

    await expect(loadPreferences()).resolves.toEqual({ baseFontSize: 19 });
    expect(JSON.parse(mocks.getPreferencesJson() ?? "")).toEqual({ baseFontSize: 19 });
    expect(mocks.getStoredValue("t3code.preferences.fallback")).toBeNull();
  });

  it("ignores a stale fallback when its previous deletion failed", async () => {
    mocks.setPreferencesJson(JSON.stringify({ baseFontSize: 21 }), 30);
    await mocks.setItemAsync(
      "t3code.preferences.fallback",
      JSON.stringify({
        payload: JSON.stringify({ baseFontSize: 19 }),
        updatedAt: 20,
      }),
    );

    await expect(loadPreferences()).resolves.toEqual({ baseFontSize: 21 });
    expect(JSON.parse(mocks.getPreferencesJson() ?? "")).toEqual({ baseFontSize: 21 });
    expect(mocks.getStoredValue("t3code.preferences.fallback")).toBeNull();
  });

  it("ignores an invalid fallback even when it has a newer timestamp", async () => {
    mocks.setPreferencesJson(JSON.stringify({ baseFontSize: 21 }), 30);
    await mocks.setItemAsync(
      "t3code.preferences.fallback",
      JSON.stringify({ payload: "{", updatedAt: 40 }),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(loadPreferences()).resolves.toEqual({ baseFontSize: 21 });
    expect(JSON.parse(mocks.getPreferencesJson() ?? "")).toEqual({ baseFontSize: 21 });
    expect(mocks.getStoredValue("t3code.preferences.fallback")).toBeNull();

    warn.mockRestore();
  });

  it("keeps SQLite authoritative when stale legacy preferences remain", async () => {
    mocks.setPreferencesJson(JSON.stringify({ baseFontSize: 21 }), 30);
    await mocks.setItemAsync("t3code.preferences", JSON.stringify({ baseFontSize: 19 }));

    await expect(loadPreferences()).resolves.toEqual({ baseFontSize: 21 });
    expect(JSON.parse(mocks.getPreferencesJson() ?? "")).toEqual({ baseFontSize: 21 });
  });
});
