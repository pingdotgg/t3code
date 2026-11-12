import { describe, expect, it } from "vite-plus/test";

import { resolveActiveUiLocale, resolveUiLocale, selectedUiLocaleChoice } from "./uiLocale";

describe("resolveUiLocale", () => {
  it("prefers an explicit server setting over the system language", () => {
    expect(resolveUiLocale("en", "zh-Hans-CN")).toBe("en");
    expect(resolveUiLocale("zh-Hans", "en-US")).toBe("zh-Hans");
  });

  it("maps zh system locales to zh-Hans and everything else to en", () => {
    expect(resolveUiLocale("system", "zh-Hans-CN")).toBe("zh-Hans");
    expect(resolveUiLocale("system", "zh_TW")).toBe("zh-Hans");
    expect(resolveUiLocale("system", "en-US")).toBe("en");
    expect(resolveUiLocale("system", "fr-CH")).toBe("en");
    expect(resolveUiLocale(null, null)).toBe("en");
  });
});

describe("resolveActiveUiLocale", () => {
  it("falls back to the system language when settings carry no explicit value", () => {
    expect(resolveActiveUiLocale([null, {}], "zh-SG")).toBe("zh-Hans");
    expect(resolveActiveUiLocale([null, {}], "en-US")).toBe("en");
  });

  it("takes the first explicit setting across connected environments", () => {
    expect(resolveActiveUiLocale([{ uiLocale: "en" }, { uiLocale: "zh-Hans" }], "en-US")).toBe(
      "en",
    );
    expect(resolveActiveUiLocale([null, { uiLocale: "zh-Hans" }], "en-US")).toBe("zh-Hans");
  });
});

describe("selectedUiLocaleChoice", () => {
  it("shows the uniform choice, or system when unset or mixed", () => {
    expect(selectedUiLocaleChoice([null, { uiLocale: "system" }])).toBe("system");
    expect(selectedUiLocaleChoice([{ uiLocale: "zh-Hans" }, { uiLocale: "zh-Hans" }])).toBe(
      "zh-Hans",
    );
    expect(selectedUiLocaleChoice([{ uiLocale: "en" }, null])).toBe("system");
  });
});
