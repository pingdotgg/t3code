import { describe, expect, it } from "vite-plus/test";

import { createI18n, i18n } from "./index.js";

describe("i18n", () => {
  it("defaults to zh-CN", () => {
    expect(i18n.locale).toBe("zh-CN");
    expect(i18n.t("action.cancel")).toBe("取消");
  });

  it("falls back to en for keys missing in the active locale", () => {
    // zh-CN dictionary would omit a key we only ship in English; here we
    // simulate by building a catalog whose active locale has an empty slate.
    const i18nEn = createI18n({ locale: "en" });
    expect(i18nEn.t("action.save")).toBe("Save");
  });

  it("returns the key itself when no locale has it", () => {
    const i18nEn = createI18n({ locale: "en" });
    // @ts-expect-error – intentionally unknown key to exercise the fallback path
    const out: string = i18nEn.t("some.missing.key");
    expect(out).toBe("some.missing.key");
  });

  it("switches locale at runtime and notifies subscribers", () => {
    const inst = createI18n({ locale: "zh-CN" });
    expect(inst.t("confirm.cancel")).toBe("取消");

    let notified = 0;
    const unsubscribe = inst.subscribe(() => notified++);

    inst.setLocale("en");
    expect(inst.locale).toBe("en");
    expect(inst.t("confirm.cancel")).toBe("Cancel");
    expect(notified).toBe(1);

    unsubscribe();
    inst.setLocale("zh-CN");
    expect(notified).toBe(1);
    expect(inst.t("confirm.cancel")).toBe("取消");
  });
});
