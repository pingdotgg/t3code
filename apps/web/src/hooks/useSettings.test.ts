import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
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
  persistClientSettingsPatch,
  persistClientSettingsUpdate,
  resolveEnvironmentIdentificationMode,
} from "./useSettings";

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
  const onboardingCompletedAt = "2026-09-05T12:00:00.000Z";
  const complete = (current: ClientSettings) => ({ ...current, onboardingCompletedAt });

  it("rejects completion after a failed read and preserves saved preferences on retry", async () => {
    const failure = new Error("storage unavailable");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    persistenceMocks.getClientSettings
      .mockRejectedValueOnce(failure)
      .mockResolvedValue(savedSettings);

    await expect(persistClientSettingsUpdate(complete)).rejects.toBe(failure);
    expect(persistenceMocks.setClientSettings).not.toHaveBeenCalled();
    expect(getClientSettings()).toBe(DEFAULT_CLIENT_SETTINGS);

    const completedSettings = { ...savedSettings, onboardingCompletedAt };
    await expect(persistClientSettingsUpdate(complete)).resolves.toEqual(completedSettings);
    expect(persistenceMocks.setClientSettings).toHaveBeenCalledExactlyOnceWith(completedSettings);
    expect(persistenceMocks.getClientSettings).toHaveBeenCalledTimes(2);
  });

  it("uses defaults only after storage confirms no saved settings exist", async () => {
    const completedSettings = { ...DEFAULT_CLIENT_SETTINGS, onboardingCompletedAt };

    await expect(persistClientSettingsUpdate(complete)).resolves.toEqual(completedSettings);
    expect(persistenceMocks.getClientSettings).toHaveBeenCalledOnce();
    expect(persistenceMocks.setClientSettings).toHaveBeenCalledExactlyOnceWith(completedSettings);
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

  it("handles failed patch reads without writing and retries with the saved preferences", async () => {
    const failure = new Error("storage unavailable");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    persistenceMocks.getClientSettings.mockRejectedValue(failure);

    const hydration = ensureClientSettingsHydrated();
    persistClientSettingsPatch({ wordWrap: false });
    await expect(hydration).rejects.toBe(failure);
    expect(persistenceMocks.setClientSettings).not.toHaveBeenCalled();

    persistenceMocks.getClientSettings.mockResolvedValue(savedSettings);
    const persisted = new Promise<ClientSettings>((resolve) => {
      persistenceMocks.setClientSettings.mockImplementationOnce(async (settings) => {
        resolve(settings);
      });
    });
    persistClientSettingsPatch({ wordWrap: false });

    await expect(persisted).resolves.toEqual({ ...savedSettings, wordWrap: false });
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

    const expected = { ...savedSettings, onboardingCompletedAt, wordWrap: true };
    expect(getClientSettings()).toEqual(expected);
    expect(durableSettings).toEqual(expected);
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

  it("keeps the current snapshot and propagates persistence failure", async () => {
    const failure = new Error("disk full");
    const setClientSettings = vi.fn().mockRejectedValue(failure);
    __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);

    await expect(
      persistClientSettingsUpdate(
        (current) => ({ ...current, timestampFormat: "12-hour" }),
        setClientSettings,
      ),
    ).rejects.toBe(failure);
    expect(getClientSettings()).toBe(DEFAULT_CLIENT_SETTINGS);
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
    persistClientSettingsPatch({ wordWrap: false }, persist);
    finishFirstPersistence();
    await pending;
    await Promise.resolve();

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

  it("orders an awaited update after an older optimistic write", async () => {
    let finishOldWrite!: () => void;
    let durableSettings = DEFAULT_CLIENT_SETTINGS;
    const oldWrite = new Promise<void>((resolve) => {
      finishOldWrite = resolve;
    });
    const persist = vi
      .fn<(settings: typeof DEFAULT_CLIENT_SETTINGS) => Promise<void>>()
      .mockImplementationOnce((settings) =>
        oldWrite.then(() => {
          durableSettings = settings;
        }),
      )
      .mockImplementation(async (settings) => {
        durableSettings = settings;
      });
    __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);

    persistClientSettingsPatch({ wordWrap: false }, persist);
    const importedProfile = { id: "profile-import", name: "Imported", kind: "persistent" as const };
    const registration = persistClientSettingsUpdate(
      (current) => ({
        ...current,
        browserProfiles: [...current.browserProfiles, importedProfile],
      }),
      persist,
    );
    await Promise.resolve();
    expect(persist).toHaveBeenCalledTimes(1);

    finishOldWrite();
    await registration;

    expect(persist).toHaveBeenCalledTimes(2);
    expect(durableSettings.wordWrap).toBe(false);
    expect(durableSettings.browserProfiles).toContainEqual(importedProfile);
  });

  it("continues the queue after a rejected write", async () => {
    const failure = new Error("disk full");
    const persist = vi
      .fn<(settings: typeof DEFAULT_CLIENT_SETTINGS) => Promise<void>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValue(undefined);
    __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);

    await expect(
      persistClientSettingsUpdate(
        (current) => ({ ...current, timestampFormat: "12-hour" }),
        persist,
      ),
    ).rejects.toBe(failure);
    await expect(
      persistClientSettingsUpdate((current) => ({ ...current, wordWrap: false }), persist),
    ).resolves.toMatchObject({ wordWrap: false });
  });
});

describe("resolveEnvironmentIdentificationMode", () => {
  it("keeps identification hidden until client settings hydrate", () => {
    expect(resolveEnvironmentIdentificationMode({ mode: "artwork", settingsHydrated: false })).toBe(
      "none",
    );
    expect(resolveEnvironmentIdentificationMode({ mode: "pill", settingsHydrated: true })).toBe(
      "pill",
    );
  });

  it("uses a pill instead of artwork with a palette theme", () => {
    expect(
      resolveEnvironmentIdentificationMode({
        mode: "artwork",
        settingsHydrated: true,
        paletteThemeActive: true,
      }),
    ).toBe("pill");
  });

  it("respects none with a palette theme", () => {
    expect(
      resolveEnvironmentIdentificationMode({
        mode: "none",
        settingsHydrated: true,
        paletteThemeActive: true,
      }),
    ).toBe("none");
  });

  it("keeps artwork when the palette theme opts into it", () => {
    expect(
      resolveEnvironmentIdentificationMode({
        mode: "artwork",
        settingsHydrated: true,
        paletteThemeActive: true,
        paletteThemeAllowsArtwork: true,
      }),
    ).toBe("artwork");
  });
});

describe("mergeEnvironmentSettings", () => {
  it("combines the selected environment's server settings with client preferences", () => {
    const serverSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [ProviderInstanceId.make("codex_remote")]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
        },
      },
    };
    const clientSettings = {
      ...DEFAULT_CLIENT_SETTINGS,
      favorites: [
        {
          provider: ProviderInstanceId.make("codex_remote"),
          model: "gpt-5.4",
        },
      ],
    };

    const settings = mergeEnvironmentSettings(serverSettings, clientSettings);

    expect(settings.providerInstances).toBe(serverSettings.providerInstances);
    expect(settings.favorites).toBe(clientSettings.favorites);
  });

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

describe("onboarding completion persistence", () => {
  it("keeps onboarding incomplete after a failed save and preserves preferences on retry", async () => {
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
    const onboardingCompletedAt = "2026-09-01T12:00:00.000Z";
    const complete = (current: typeof DEFAULT_CLIENT_SETTINGS) => ({
      ...current,
      onboardingCompletedAt,
    });

    await expect(persistClientSettingsUpdate(complete, persist)).rejects.toBe(failure);
    expect(getClientSettings()).toBe(existingSettings);
    expect(getClientSettings().onboardingCompletedAt).toBeNull();

    const completedSettings = { ...existingSettings, onboardingCompletedAt };
    await expect(persistClientSettingsUpdate(complete, persist)).resolves.toEqual(
      completedSettings,
    );
    expect(getClientSettings()).toEqual(completedSettings);
    expect(persist).toHaveBeenLastCalledWith(completedSettings);
  });
});
