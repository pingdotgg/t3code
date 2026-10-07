import { describe, expect, it } from "vite-plus/test";
import { createTranslator } from "./index";

describe("interface translation", () => {
  it("preserves the English source copy", () => {
    expect(createTranslator("en")("Settings")).toBe("Settings");
  });
  it("translates Chinese without changing another client's English translator", () => {
    const english = createTranslator("en");
    const chinese = createTranslator("zh-CN");
    expect(chinese("Settings")).toBe("设置");
    expect(chinese("Interface language")).toBe("界面语言");
    expect(english("Settings")).toBe("Settings");
  });
  it("falls back for untranslated copy, including inherited property names", () => {
    const t = createTranslator("zh-CN");
    expect(t("An untranslated message")).toBe("An untranslated message");
    expect(t("constructor")).toBe("constructor");
    expect(t("toString")).toBe("toString");
  });
  it("interpolates whole messages without reinterpreting supplied values", () => {
    expect(createTranslator("zh-CN")("{modifier} + Enter always", { modifier: "Ctrl" })).toBe(
      "始终使用 Ctrl + Enter",
    );
    expect(createTranslator("en")("{modifier} + Enter always", { modifier: "⌘" })).toBe(
      "⌘ + Enter always",
    );
    expect(createTranslator("en")("Project {name}: {count}", { name: "{count}", count: 0 })).toBe(
      "Project {count}: 0",
    );
    expect(createTranslator("en")("Missing {name}")).toBe("Missing {name}");
  });
});
