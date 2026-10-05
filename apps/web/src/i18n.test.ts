// @vitest-environment jsdom
import { describe, expect, it } from "vite-plus/test";

import { changeLanguage, i18n } from "./i18n";

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
