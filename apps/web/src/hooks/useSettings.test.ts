import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { describe, expect, it } from "vite-plus/test";

import { getShortcutRuntime, setShortcutRuntime } from "../shortcutRuntime";
import {
  __resetClientSettingsPersistenceForTests,
  __setClientSettingsForTests,
  mergeEnvironmentSettings,
  resolveEnvironmentIdentificationMode,
  startShortcutRuntimeSync,
} from "./useSettings";

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
});

describe("startShortcutRuntimeSync", () => {
  it("applies the persisted opt-out at startup", () => {
    __resetClientSettingsPersistenceForTests();
    setShortcutRuntime("desktop");

    // jsdom is not Electron, so default settings put the app in a browser
    // session and the matcher flips `mod` to Control.
    const stopEnabled = startShortcutRuntimeSync();
    expect(getShortcutRuntime()).toBe("browser");
    stopEnabled();

    __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, browserModKeyFlip: false });
    const stopDisabled = startShortcutRuntimeSync();
    expect(getShortcutRuntime()).toBe("desktop");
    stopDisabled();

    __resetClientSettingsPersistenceForTests();
    setShortcutRuntime("desktop");
  });
});
