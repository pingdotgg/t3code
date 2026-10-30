import { describe, expect, it } from "vite-plus/test";

import {
  USAGE_CREDIT_VENDOR_ICONS,
  type UsageCreditVendor,
  usageCreditVendor,
} from "./usageCreditIcons.ts";

describe("usage credit vendor glyphs", () => {
  it.each([
    [{ id: "openrouter", label: "OpenRouter" }, "openrouter"],
    [{ id: "deepseek-USD", label: "DeepSeek" }, "deepseek"],
    [{ id: "deepseek-CNY", label: "DeepSeek" }, "deepseek"],
    [{ id: "venice-USD", label: "Venice" }, "venice"],
    [{ id: "credits-3", label: "Kimi" }, "moonshot"],
    [{ id: "zhipu_ai", label: "GLM" }, "zai"],
    [{ id: "account-1", label: "Grok" }, "xai"],
    [{ id: "qwen-prod", label: "Qwen" }, "alibaba"],
  ])("infers %j as %s", (balance, vendor) => {
    expect(usageCreditVendor(balance)).toBe(vendor);
  });

  it("prefers an explicit icon from the endpoint", () => {
    expect(usageCreditVendor({ id: "deepseek-USD", label: "DeepSeek", icon: "Groq" })).toBe("groq");
  });

  it("returns undefined for unknown vendors so cards fall back to initials", () => {
    expect(usageCreditVendor({ id: "my-proxy", label: "House proxy" })).toBeUndefined();
    expect(usageCreditVendor({ id: "x", label: "y", icon: "nope" })).toBeUndefined();
  });

  it("ships a renderable glyph for every vendor", () => {
    for (const vendor of Object.keys(USAGE_CREDIT_VENDOR_ICONS) as UsageCreditVendor[]) {
      const icon = USAGE_CREDIT_VENDOR_ICONS[vendor];
      expect(icon.viewBox, vendor).toMatch(/^0 0 \d+ \d+$/);
      expect(icon.paths.length, vendor).toBeGreaterThan(0);
      for (const path of icon.paths) expect(path.d, vendor).toMatch(/^[Mm]/);
    }
  });
});
