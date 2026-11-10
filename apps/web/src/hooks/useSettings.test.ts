import {
  DEFAULT_SERVER_SETTINGS,
  DEFAULT_LAYOUT_SETTINGS,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from "@t3tools/contracts/settings";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const persistenceMocks = vi.hoisted(() => ({
  getClientSettings: vi.fn<() => Promise<ClientSettings | null>>(),
  setClientSettings: vi.fn<(settings: ClientSettings) => Promise<void>>(),
}));

vi.mock("~/localApi", () => ({
  ensureLocalApi: () => ({ persistence: persistenceMocks }),
}));

import {
  __resetClientSettingsPersistenceForTests,
  __setClientSettingsForTests,
  ensureClientSettingsHydrated,
  getClientSettings,
  mergeEnvironmentSettings,
  migrateLegacyLayoutSettings,
  persistClientSettingsPatch,
  persistClientSettingsUpdate,
  prepareModelPreferencesPatch,
} from "./useSettings";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";

beforeEach(() => {
  persistenceMocks.getClientSettings.mockReset().mockResolvedValue(null);
  persistenceMocks.setClientSettings.mockReset().mockResolvedValue(undefined);
  __resetClientSettingsPersistenceForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("client settings hydration", () => {
  const savedSettings = {
    ...DEFAULT_CLIENT_SETTINGS,
    timestampFormat: "12-hour" as const,
    favorites: [{ provider: ProviderInstanceId.make("codex_work"), model: "gpt-5.6" }],
  };
  const complete = (current: ClientSettings) => ({ ...current, fontSmoothing: false });

  it("waits for saved model preferences before applying the first server edit", async () => {
    const provider = ProviderInstanceId.make("codex_work");
    let finishRead!: (settings: ClientSettings) => void;
    persistenceMocks.getClientSettings.mockReturnValueOnce(
      new Promise((resolve) => {
        finishRead = resolve;
      }),
    );
    const patch = prepareModelPreferencesPatch(DEFAULT_SERVER_SETTINGS, {
      setModelFavorites: [{ provider, model: "new", favorite: true }],
      setModelsHidden: [{ provider, model: "new", hidden: true }],
    });
    expect(getClientSettings()).toBe(DEFAULT_CLIENT_SETTINGS);
    finishRead({
      ...savedSettings,
      providerModelPreferences: {
        [provider]: { hiddenModels: ["saved-hidden"], modelOrder: ["saved-order"] },
      },
    });
    const edited = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, await patch);
    expect(edited.favorites).toEqual([...savedSettings.favorites, { provider, model: "new" }]);
    expect(edited.providerModelPreferences?.[provider]).toEqual({
      hiddenModels: ["saved-hidden", "new"],
      modelOrder: ["saved-order"],
    });
  });

  // regression: #16816 a failed read could overwrite synced model favorites with defaults
  it("does not prepare a model preference write after a failed legacy read", async () => {
    const failure = new Error("storage unavailable");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    persistenceMocks.getClientSettings.mockRejectedValueOnce(failure);
    await expect(
      prepareModelPreferencesPatch(DEFAULT_SERVER_SETTINGS, {
        setProviderModelOrder: { provider: ProviderInstanceId.make("codex_work"), modelOrder: [] },
      }),
    ).rejects.toBe(failure);
  });

  it("rejects completion after a failed read and preserves saved preferences on retry", async () => {
    const failure = new Error("storage unavailable");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    persistenceMocks.getClientSettings
      .mockRejectedValueOnce(failure)
      .mockResolvedValue(savedSettings);

    await expect(persistClientSettingsUpdate(complete)).rejects.toBe(failure);
    expect(persistenceMocks.setClientSettings).not.toHaveBeenCalled();
    expect(getClientSettings()).toBe(DEFAULT_CLIENT_SETTINGS);

    const completedSettings = { ...savedSettings, fontSmoothing: false };
    await expect(persistClientSettingsUpdate(complete)).resolves.toEqual(completedSettings);
    expect(persistenceMocks.setClientSettings).toHaveBeenCalledExactlyOnceWith(completedSettings);
    expect(persistenceMocks.getClientSettings).toHaveBeenCalledTimes(2);
  });

  it("holds patches until a pending read supplies the saved preferences", async () => {
    let finishRead!: (settings: ClientSettings) => void;
    persistenceMocks.getClientSettings.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRead = resolve;
        }),
    );
    const persisted = new Promise<ClientSettings>((resolve) => {
      persistenceMocks.setClientSettings.mockImplementationOnce(async (settings) => {
        resolve(settings);
      });
    });

    const hydration = ensureClientSettingsHydrated();
    persistClientSettingsPatch({ wordWrap: false });
    expect(getClientSettings()).toBe(DEFAULT_CLIENT_SETTINGS);
    expect(persistenceMocks.setClientSettings).not.toHaveBeenCalled();

    finishRead(savedSettings);
    await hydration;
    await expect(persisted).resolves.toEqual({ ...savedSettings, wordWrap: false });
    expect(persistenceMocks.getClientSettings).toHaveBeenCalledOnce();
  });

  it("preserves patch order across hydration and a blocked completion write", async () => {
    let finishRead!: (settings: ClientSettings) => void;
    const read = new Promise<ClientSettings>((resolve) => {
      finishRead = resolve;
    });
    persistenceMocks.getClientSettings.mockReturnValue(read);
    let finishCompletionWrite!: () => void;
    const blockedWrite = new Promise<void>((resolve) => {
      finishCompletionWrite = resolve;
    });
    let signalCompletionWrite!: () => void;
    const completionWriteStarted = new Promise<void>((resolve) => {
      signalCompletionWrite = resolve;
    });
    let durableSettings: ClientSettings = savedSettings;
    const persist = vi
      .fn<(settings: ClientSettings) => Promise<void>>()
      .mockImplementationOnce(async (settings) => {
        signalCompletionWrite();
        await blockedWrite;
        durableSettings = settings;
      })
      .mockImplementation(async (settings) => {
        durableSettings = settings;
      });

    const completion = persistClientSettingsUpdate(complete, persist);
    persistClientSettingsPatch({ wordWrap: false }, persist);
    finishRead(savedSettings);
    await completionWriteStarted;
    persistClientSettingsPatch({ wordWrap: true }, persist);
    const finalWrite = persistClientSettingsUpdate((current) => current, persist);

    finishCompletionWrite();
    await completion;
    await finalWrite;

    const expected = { ...savedSettings, fontSmoothing: false, wordWrap: true };
    expect(getClientSettings()).toEqual(expected);
    expect(durableSettings).toEqual(expected);
  });
});

describe("persistClientSettingsPatch", () => {
  it("waits for settings writes in request order", async () => {
    __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
    let finishFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    persistenceMocks.setClientSettings.mockImplementationOnce(() => {
      markFirstStarted();
      return new Promise<void>((resolve) => {
        finishFirst = resolve;
      });
    });

    const firstSettings = { ...DEFAULT_CLIENT_SETTINGS, snapShotFlash: false };
    const secondSettings = { ...firstSettings, snapShotPlaySound: false };
    const first = persistClientSettingsPatch({ snapShotFlash: false });
    await firstStarted;
    const second = persistClientSettingsPatch({ snapShotPlaySound: false });

    expect(persistenceMocks.setClientSettings).toHaveBeenCalledTimes(1);
    expect(getClientSettings()).toEqual(secondSettings);
    finishFirst();
    await Promise.all([first, second]);

    expect(persistenceMocks.setClientSettings).toHaveBeenNthCalledWith(1, firstSettings);
    expect(persistenceMocks.setClientSettings).toHaveBeenNthCalledWith(2, secondSettings);
  });
});

describe("persistClientSettingsUpdate", () => {
  it("publishes the update only after persistence succeeds", async () => {
    let finishPersistence!: () => void;
    const persistence = new Promise<void>((resolve) => {
      finishPersistence = resolve;
    });
    const setClientSettings = vi.fn(() => persistence);
    __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);

    const pending = persistClientSettingsUpdate(
      (current) => ({
        ...current,
        timestampFormat: "12-hour",
      }),
      setClientSettings,
    );

    expect(getClientSettings().timestampFormat).toBe(DEFAULT_CLIENT_SETTINGS.timestampFormat);
    finishPersistence();
    await expect(pending).resolves.toMatchObject({ timestampFormat: "12-hour" });
    expect(getClientSettings().timestampFormat).toBe("12-hour");
  });

  it("preserves an optimistic write made while an awaited update persists", async () => {
    let finishFirstPersistence!: () => void;
    let durableSettings = DEFAULT_CLIENT_SETTINGS;
    const firstPersistence = new Promise<void>((resolve) => {
      finishFirstPersistence = resolve;
    });
    const persist = vi
      .fn<(settings: typeof DEFAULT_CLIENT_SETTINGS) => Promise<void>>()
      .mockImplementationOnce((settings) =>
        firstPersistence.then(() => {
          durableSettings = settings;
        }),
      )
      .mockImplementation(async (settings) => {
        durableSettings = settings;
      });
    __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
    const importedProfile = { id: "profile-import", name: "Imported", kind: "persistent" as const };

    const pending = persistClientSettingsUpdate(
      (current) => ({
        ...current,
        browserProfiles: [...current.browserProfiles, importedProfile],
      }),
      persist,
    );
    await Promise.resolve();
    const patch = persistClientSettingsPatch({ wordWrap: false }, persist);
    finishFirstPersistence();
    await Promise.all([pending, patch]);

    expect(persist).toHaveBeenCalledTimes(3);
    expect(persist.mock.calls[1]?.[0]).toMatchObject({
      wordWrap: false,
    });
    expect(persist.mock.calls[1]?.[0].browserProfiles).toContainEqual(importedProfile);
    expect(durableSettings.wordWrap).toBe(false);
    expect(durableSettings.browserProfiles).toContainEqual(importedProfile);
    expect(getClientSettings().wordWrap).toBe(false);
    expect(getClientSettings().browserProfiles).toContainEqual(importedProfile);
  });
});

describe("mergeEnvironmentSettings", () => {
  it("keeps server settlement settings when legacy client data contains retired keys", () => {
    const serverSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      sidebarAutoSettleAfterDays: 14,
      sidebarAutoSettleOnMerge: false,
    };
    const legacyClientSettings = {
      ...DEFAULT_CLIENT_SETTINGS,
      sidebarAutoSettleAfterDays: 1,
      sidebarAutoSettleOnMerge: true,
    };

    const settings = mergeEnvironmentSettings(serverSettings, legacyClientSettings);

    expect(settings.sidebarAutoSettleAfterDays).toBe(14);
    expect(settings.sidebarAutoSettleOnMerge).toBe(false);
  });
});

describe("client settings update persistence", () => {
  it("keeps the old value after a failed save and preserves preferences on retry", async () => {
    const failure = new Error("disk full");
    const persist = vi
      .fn<(settings: typeof DEFAULT_CLIENT_SETTINGS) => Promise<void>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValue(undefined);
    const existingSettings = {
      ...DEFAULT_CLIENT_SETTINGS,
      timestampFormat: "12-hour" as const,
      favorites: [
        {
          provider: ProviderInstanceId.make("codex_work"),
          model: "gpt-5.6",
        },
      ],
    };
    __setClientSettingsForTests(existingSettings);
    const complete = (current: typeof DEFAULT_CLIENT_SETTINGS) => ({
      ...current,
      fontSmoothing: false,
    });

    await expect(persistClientSettingsUpdate(complete, persist)).rejects.toBe(failure);
    expect(getClientSettings()).toBe(existingSettings);
    expect(getClientSettings().fontSmoothing).toBe(true);

    const completedSettings = { ...existingSettings, fontSmoothing: false };
    await expect(persistClientSettingsUpdate(complete, persist)).resolves.toEqual(
      completedSettings,
    );
    expect(getClientSettings()).toEqual(completedSettings);
    expect(persist).toHaveBeenLastCalledWith(completedSettings);
  });
});

it("uses the environment's model preferences after migration, including empty lists", () => {
  const client = {
    ...DEFAULT_CLIENT_SETTINGS,
    favorites: [{ provider: ProviderInstanceId.make("codex_work"), model: "old" }],
    providerModelPreferences: { codex_work: { hiddenModels: ["old"], modelOrder: [] } },
  };
  expect(mergeEnvironmentSettings(DEFAULT_SERVER_SETTINGS, client).favorites).toEqual(
    client.favorites,
  );
  const merged = mergeEnvironmentSettings(
    { ...DEFAULT_SERVER_SETTINGS, favorites: [], providerModelPreferences: {} },
    client,
  );
  expect(merged.favorites).toEqual([]);
  expect(merged.providerModelPreferences).toEqual({});
});

describe("legacy layout migration", () => {
  const legacyLayout = { ...DEFAULT_LAYOUT_SETTINGS, terminalPlacement: "new-column" as const };

  it("copies layout once after hydration and preserves the client's other preferences", async () => {
    persistenceMocks.getClientSettings.mockResolvedValue({
      ...DEFAULT_CLIENT_SETTINGS,
      wordWrap: false,
    });
    await migrateLegacyLayoutSettings(legacyLayout);
    expect(getClientSettings()).toMatchObject({ layout: legacyLayout, wordWrap: false });
    expect(persistenceMocks.setClientSettings).toHaveBeenCalledExactlyOnceWith(getClientSettings());

    await migrateLegacyLayoutSettings({ ...legacyLayout, newTabPosition: "end" });
    expect(getClientSettings().layout).toEqual(legacyLayout);
    expect(persistenceMocks.setClientSettings).toHaveBeenCalledOnce();
  });

  it("keeps an existing client layout even when it matches the defaults", async () => {
    persistenceMocks.getClientSettings.mockResolvedValue({
      ...DEFAULT_CLIENT_SETTINGS,
      layout: DEFAULT_LAYOUT_SETTINGS,
    });
    await migrateLegacyLayoutSettings(legacyLayout);
    expect(getClientSettings().layout).toEqual(DEFAULT_LAYOUT_SETTINGS);
    expect(persistenceMocks.setClientSettings).not.toHaveBeenCalled();
  });

  it("leaves migration retryable when persistence fails", async () => {
    const failure = new Error("disk full");
    persistenceMocks.setClientSettings.mockRejectedValueOnce(failure);
    await expect(migrateLegacyLayoutSettings(legacyLayout)).rejects.toBe(failure);
    expect(getClientSettings().layout).toBeUndefined();
    await migrateLegacyLayoutSettings(legacyLayout);
    expect(getClientSettings().layout).toEqual(legacyLayout);
  });

  it("keeps an edit made while migration is being persisted", async () => {
    let finishMigration!: () => void;
    const pending = new Promise<void>((resolve) => {
      finishMigration = resolve;
    });
    let signalWrite!: () => void;
    const writeStarted = new Promise<void>((resolve) => {
      signalWrite = resolve;
    });
    persistenceMocks.setClientSettings.mockImplementationOnce(async () => {
      signalWrite();
      await pending;
    });
    const migration = migrateLegacyLayoutSettings(legacyLayout);
    await writeStarted;
    const edit = persistClientSettingsPatch({ layout: { sidePaneOpensOn: "files" } });
    finishMigration();
    await Promise.all([migration, edit]);
    expect(getClientSettings().layout).toEqual({
      ...DEFAULT_LAYOUT_SETTINGS,
      sidePaneOpensOn: "files",
    });
    expect(persistenceMocks.setClientSettings).toHaveBeenLastCalledWith(getClientSettings());
  });

  it("merges layout patches without losing the template or other behavior", async () => {
    await migrateLegacyLayoutSettings(legacyLayout);
    await persistClientSettingsPatch({ layout: { sidePaneOpensOn: "files" } });
    await persistClientSettingsPatch({ layout: { newTabPosition: "end" } });
    expect(getClientSettings().layout).toEqual({
      ...legacyLayout,
      sidePaneOpensOn: "files",
      newTabPosition: "end",
    });
  });

  it("ignores a connected server's legacy layout when merging settings", () => {
    const serverSettings = { ...DEFAULT_SERVER_SETTINGS, layout: legacyLayout };
    expect(
      mergeEnvironmentSettings(serverSettings, DEFAULT_CLIENT_SETTINGS).layout,
    ).toBeUndefined();
    expect(
      mergeEnvironmentSettings(serverSettings, {
        ...DEFAULT_CLIENT_SETTINGS,
        layout: DEFAULT_LAYOUT_SETTINGS,
      }).layout,
    ).toEqual(DEFAULT_LAYOUT_SETTINGS);
  });
});
