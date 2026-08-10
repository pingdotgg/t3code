import { describe, expect, it } from "vite-plus/test";

import { normalizeLocale, translate } from "./index.ts";

describe("i18n", () => {
  it("normalizes Chinese variants and falls back to English", () => {
    expect(normalizeLocale("zh_CN")).toBe("zh-CN");
    expect(normalizeLocale("zh-Hans-CN")).toBe("zh-CN");
    expect(normalizeLocale("fr-FR")).toBe("en");
  });

  it("translates and interpolates typed messages", () => {
    expect(translate("zh-CN", "settings.title")).toBe("设置");
    expect(translate("en", "desktop.upToDateBody", { version: "1.2.3" })).toContain("1.2.3");
  });
});
