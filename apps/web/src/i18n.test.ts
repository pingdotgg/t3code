// @vitest-environment jsdom
import { act, createElement, Fragment } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { LanguagePreference } from "@t3tools/client-runtime/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const settings = vi.hoisted(() => ({
  hydrated: false,
  languagePreference: "system" as LanguagePreference,
}));

vi.mock("./hooks/useSettings", () => ({
  useClientSettings: (selector: (value: { languagePreference: LanguagePreference }) => unknown) =>
    selector(settings),
  useClientSettingsHydrated: () => settings.hydrated,
}));

import { changeLanguage, i18n, LanguageSync, useTranslate } from "./i18n";

/**
 * The web binding initializes i18next at module load, then registers the React
 * plugin. These tests pin the ordering, because the plugin's `init` hook only
 * runs while the instance is initializing: registering it afterwards would
 * silently leave `useTranslation` on its fallback path.
 */
describe("web i18n binding", () => {
  it("registers with react-i18next", async () => {
    const { getI18n } = await import("react-i18next");
    expect(getI18n()).toBe(i18n);
  });

  it("is usable immediately, with no provider and no await", () => {
    expect(i18n.isInitialized).toBe(true);
    expect(i18n.t("wizard.continue")).toBe("Continue");
  });

  it("renders the Chinese catalog after a language change", async () => {
    await changeLanguage("zh");
    expect(i18n.t("wizard.continue")).toBe("继续");
    await changeLanguage("en");
    expect(i18n.t("wizard.continue")).toBe("Continue");
  });
});

describe("LanguageSync hydration", () => {
  let container: HTMLDivElement;
  let root: Root;
  let previousDocumentLanguage: string;

  function TranslatedLabel() {
    const t = useTranslate();
    return createElement("span", null, t("wizard.continue"));
  }

  async function render() {
    await act(async () => {
      root.render(
        createElement(Fragment, null, createElement(LanguageSync), createElement(TranslatedLabel)),
      );
    });
  }

  beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    settings.hydrated = false;
    settings.languagePreference = "system";
    await changeLanguage("en");
    previousDocumentLanguage = document.documentElement.lang;
    document.documentElement.lang = "en";
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    await changeLanguage("en");
    document.documentElement.lang = previousDocumentLanguage;
    settings.hydrated = false;
    settings.languagePreference = "system";
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([
    ["zh-CN", "en", "Continue"],
    ["en-US", "zh", "继续"],
  ] as const)(
    "waits for the saved %s browser / %s preference before applying language",
    async (browserLanguage, savedPreference, label) => {
      vi.spyOn(navigator, "languages", "get").mockReturnValue([browserLanguage]);
      const languageChanges: string[] = [];
      const recordLanguageChange = (language: string) => languageChanges.push(language);
      i18n.on("languageChanged", recordLanguageChange);
      try {
        await render();
        expect(container.textContent).toBe("Continue");
        expect(i18n.resolvedLanguage).toBe("en");
        expect(document.documentElement.lang).toBe("en");
        expect(languageChanges).toEqual([]);

        settings.languagePreference = savedPreference;
        settings.hydrated = true;
        await render();
        expect(container.textContent).toBe(label);
        expect(i18n.resolvedLanguage).toBe(savedPreference);
        expect(document.documentElement.lang).toBe(savedPreference);
        expect(languageChanges).toEqual(savedPreference === "en" ? [] : ["zh"]);
      } finally {
        i18n.off("languageChanged", recordLanguageChange);
      }
    },
  );

  it("applies system language when only hydration changes", async () => {
    vi.spyOn(navigator, "languages", "get").mockReturnValue(["zh-CN"]);
    await render();
    expect(container.textContent).toBe("Continue");
    expect(document.documentElement.lang).toBe("en");

    settings.hydrated = true;
    await render();
    expect(container.textContent).toBe("继续");
    expect(i18n.resolvedLanguage).toBe("zh");
    expect(document.documentElement.lang).toBe("zh");
  });

  it("keeps syncing preference changes after hydration, including returning to system", async () => {
    vi.spyOn(navigator, "languages", "get").mockReturnValue(["zh-CN"]);
    settings.hydrated = true;
    settings.languagePreference = "zh";
    await render();
    expect(container.textContent).toBe("继续");
    expect(document.documentElement.lang).toBe("zh");

    settings.languagePreference = "en";
    await render();
    expect(container.textContent).toBe("Continue");
    expect(document.documentElement.lang).toBe("en");

    settings.languagePreference = "system";
    await render();
    expect(container.textContent).toBe("继续");
    expect(document.documentElement.lang).toBe("zh");
  });

  it("preserves the current language and document while hydration remains incomplete", async () => {
    vi.spyOn(navigator, "languages", "get").mockReturnValue(["en-US"]);
    await changeLanguage("zh");
    document.documentElement.lang = "zh";
    await render();
    expect(container.textContent).toBe("继续");
    expect(document.documentElement.lang).toBe("zh");

    settings.languagePreference = "en";
    await render();
    expect(container.textContent).toBe("继续");
    expect(i18n.resolvedLanguage).toBe("zh");
    expect(document.documentElement.lang).toBe("zh");

    settings.hydrated = true;
    await render();
    expect(container.textContent).toBe("Continue");
    expect(document.documentElement.lang).toBe("en");
  });
});

describe("LanguageSync placement", () => {
  it("is rendered above the router, so every route tree resolves it", async () => {
    // `__root` returns three separate trees (pair/connect, welcome, app shell)
    // and its branches do not share a component list. Language resolution must
    // therefore live outside it; while it lived in the app-shell branch only,
    // the welcome wizard rendered in English while Settings rendered in Chinese.
    const [appRootSource, rootSource] = await Promise.all([
      import("./AppRoot.tsx?raw").then((module) => module.default as string),
      import("./routes/__root.tsx?raw").then((module) => module.default as string),
    ]);

    expect(appRootSource).toContain("<LanguageSync />");
    expect(rootSource).not.toContain("LanguageSync");
  });
});
