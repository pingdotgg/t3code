import { describe, expect, it, vi } from "vite-plus/test";

import indexHtml from "../../index.html?raw";
import { APP_LOCALES, LOCALE_STORAGE_KEY, applyLocale, currentLocale } from "./locale";

const bootScript = indexHtml.match(/<script data-locale-boot>([\s\S]*?)<\/script>/)?.[1];
if (!bootScript) throw new Error("Missing locale boot script");

describe("document locale", () => {
  it.each([...APP_LOCALES, null, "it", "de-DE", "", '"de"'])(
    "selects a supported locale before modules execute (%s)",
    (stored) => {
      const document = { documentElement: { lang: "en" } };
      const window = {
        localStorage: { getItem: (key: string) => (key === LOCALE_STORAGE_KEY ? stored : null) },
      };
      new Function("window", "document", bootScript)(window, document);
      expect(document.documentElement.lang).toBe(
        APP_LOCALES.find((locale) => locale === stored) ?? "en",
      );
    },
  );

  it("boots in English when storage access is blocked", () => {
    const document = { documentElement: { lang: "de" } };
    const window = {
      get localStorage() {
        throw new Error("Storage blocked");
      },
    };
    new Function("window", "document", bootScript)(window, document);
    expect(document.documentElement.lang).toBe("en");
  });

  it("persists before navigation and reads the document's active locale", () => {
    const events: string[] = [];
    vi.stubGlobal("document", { documentElement: { lang: "zh-CN" } });
    vi.stubGlobal("window", {
      localStorage: {
        setItem: (key: string, value: string) => events.push(`${key}=${value}`),
      },
      location: { reload: () => events.push("reload") },
    });
    try {
      expect(currentLocale()).toBe("zh-CN");
      applyLocale("de");
      expect(events).toEqual([`${LOCALE_STORAGE_KEY}=de`, "reload"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not reload when saving the preference fails", () => {
    const reload = vi.fn();
    vi.stubGlobal("window", {
      localStorage: {
        setItem: () => {
          throw new Error("Storage blocked");
        },
      },
      location: { reload },
    });
    try {
      expect(() => applyLocale("de")).toThrow("Storage blocked");
      expect(reload).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
