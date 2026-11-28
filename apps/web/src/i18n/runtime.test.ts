import { expect, it, vi } from "vite-plus/test";

const settings = vi.hoisted(() => ({
  language: "en",
  changed: undefined as (() => void) | undefined,
}));

vi.mock("../hooks/useSettings", () => ({
  getClientSettings: () => ({ language: settings.language }),
  subscribeClientSettings: (listener: () => void) => {
    settings.changed = listener;
    return () => {};
  },
  updateClientSettings: async (patch: { language: string }) => {
    settings.language = patch.language;
    settings.changed?.();
  },
}));
vi.mock("./initializeI18n", () => ({ initializeI18n: () => {} }));
vi.mock("gt-react", () => ({ getTranslationsSnapshot: vi.fn() }));

it("activates RTL with its catalog and ignores a stale Hebrew load after switching back", async () => {
  settings.language = "en";
  settings.changed = undefined;
  vi.resetModules();
  const documentElement = { lang: "en", dir: "ltr" };
  vi.stubGlobal("document", { documentElement });
  vi.stubGlobal("navigator", { languages: ["en-US"] });
  try {
    const { getTranslationsSnapshot } = await import("gt-react");
    const translations = { "0a75e464d833bca8": "הגדרות" };
    let finishHebrew = () => {};
    const pending = new Promise<{ he: typeof translations }>((resolve) => {
      finishHebrew = () => resolve({ he: translations });
    });
    vi.mocked(getTranslationsSnapshot).mockReset().mockReturnValueOnce(pending);
    const runtime = await import("./runtime");
    runtime.startI18n();
    await runtime.whenLocaleReady();

    runtime.persistGTLocale("he");
    const hebrewReady = runtime.whenLocaleReady();
    expect(runtime.getI18nSnapshot().locale).toBe("en");
    expect(documentElement.dir).toBe("ltr");

    runtime.persistGTLocale("en");
    await runtime.whenLocaleReady();
    finishHebrew();
    await hebrewReady;
    expect(runtime.getI18nSnapshot().locale).toBe("en");
    expect(documentElement).toEqual({ lang: "en", dir: "ltr" });

    runtime.persistGTLocale("he");
    await runtime.whenLocaleReady();
    expect(runtime.getI18nSnapshot().translations.he).toEqual(translations);
    expect(documentElement).toEqual({ lang: "he", dir: "rtl" });

    runtime.persistGTLocale("en");
    await runtime.whenLocaleReady();
    expect(documentElement).toEqual({ lang: "en", dir: "ltr" });
  } finally {
    vi.unstubAllGlobals();
  }
});
