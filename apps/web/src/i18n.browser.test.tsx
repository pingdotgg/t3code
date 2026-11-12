import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from "@t3tools/contracts/settings";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../test/render";
import { UiLocaleSettingsRow } from "./components/settings/UiLocaleSettingsRow";
import {
  __resetClientSettingsPersistenceForTests,
  __setClientSettingsForTests,
  updateClientSettings,
} from "./hooks/useSettings";
import { i18n, nextUiLocale, resolveUiLanguage, startUiLocaleSync } from "./i18n";

const persistenceMocks = vi.hoisted(() => ({
  getClientSettings: vi.fn<() => Promise<ClientSettings | null>>(),
  setClientSettings: vi.fn<(settings: ClientSettings) => Promise<void>>(),
}));

vi.mock("~/localApi", () => ({
  ensureLocalApi: () => ({ persistence: persistenceMocks }),
}));

function resetSettings(uiLocale: ClientSettings["uiLocale"]): void {
  persistenceMocks.getClientSettings.mockResolvedValue(null);
  persistenceMocks.setClientSettings.mockResolvedValue(undefined);
  __resetClientSettingsPersistenceForTests();
  __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, uiLocale });
}

describe("resolveUiLanguage", () => {
  it("maps explicit locales directly", () => {
    expect(resolveUiLanguage("en", [])).toBe("en");
    expect(resolveUiLanguage("zh-Hans", [])).toBe("zh-Hans");
  });

  it("follows the device language for system", () => {
    expect(resolveUiLanguage("system", ["en-US", "en"])).toBe("en");
    expect(resolveUiLanguage("system", ["zh-Hans-CN", "en"])).toBe("zh-Hans");
    expect(resolveUiLanguage("system", ["zh-SG"])).toBe("zh-Hans");
    expect(resolveUiLanguage("system", ["zh"])).toBe("zh-Hans");
  });

  it("falls back to English when no device language is supported", () => {
    expect(resolveUiLanguage("system", ["fr-FR", "de-DE"])).toBe("en");
    expect(resolveUiLanguage("system", ["zh-Hant-TW", "zh-HK"])).toBe("en");
    expect(resolveUiLanguage("system", [])).toBe("en");
  });
});

describe("nextUiLocale", () => {
  it("cycles system, en, zh-Hans", () => {
    expect(nextUiLocale("system")).toBe("en");
    expect(nextUiLocale("en")).toBe("zh-Hans");
    expect(nextUiLocale("zh-Hans")).toBe("system");
  });
});

describe("uiLocale setting", () => {
  it("switches the rendered language when the setting changes", async () => {
    resetSettings("en");
    using _sync = { [Symbol.dispose]: startUiLocaleSync() };
    await using screen = await render(<UiLocaleSettingsRow />);
    expect(screen.getByText("Interface language")).toBeTruthy();
    expect(screen.getByText("English")).toBeTruthy();

    await act(async () => {
      await updateClientSettings({ uiLocale: "zh-Hans" });
    });
    await vi.waitFor(() => {
      expect(screen.getByText("界面语言")).toBeTruthy();
    });
    expect(screen.getByText("跟随系统")).toBeTruthy();

    await act(async () => {
      await updateClientSettings({ uiLocale: "en" });
    });
    await vi.waitFor(() => {
      expect(screen.getByText("Interface language")).toBeTruthy();
    });
  });

  it("falls back to English for keys missing from zh-Hans", async () => {
    resetSettings("zh-Hans");
    using _sync = { [Symbol.dispose]: startUiLocaleSync() };
    await act(async () => {
      await i18n.changeLanguage("zh-Hans");
    });
    expect(i18n.t("uiLocale.label")).toBe("界面语言");
    i18n.addResourceBundle("en", "settings", { fallbackProbe: "English fallback" }, true, true);
    // @ts-expect-error the probe key is only added to the en bundle at runtime
    expect(i18n.t("fallbackProbe")).toBe("English fallback");
  });
});
