import { describe, expect, it } from "vite-plus/test";

import {
  applyAppearanceFontVariables,
  areFontAdvancesMonospace,
  clampChatFontSize,
  clampCodeFontSize,
  clampInterfaceFontSize,
  clampPromptFontSize,
  DEFAULT_CODE_FONT_STACK,
  DEFAULT_SANS_FONT_STACK,
  appearanceFontStack,
  cssFontFamilies,
  resolveDefaultFamilyLabel,
  resolvePromptFontSizePreference,
  resolveTerminalFontPreference,
  resolveTerminalFontSizePreference,
} from "./appearanceFonts";

describe("areFontAdvancesMonospace", () => {
  it("accepts a fixed advance and rejects any proportional glyph", () => {
    expect(areFontAdvancesMonospace([10, 10, 10, 10])).toBe(true);
    expect(areFontAdvancesMonospace([10, 10, 7, 10])).toBe(false);
    expect(areFontAdvancesMonospace([10, 10.02])).toBe(false);
  });

  it("fails open when canvas metrics are unavailable", () => {
    expect(areFontAdvancesMonospace([])).toBe(true);
    expect(areFontAdvancesMonospace([Number.NaN, Number.NaN])).toBe(true);
  });
});

describe("cssFontFamilies", () => {
  it("returns null for effectively empty input", () => {
    expect(cssFontFamilies("")).toBeNull();
    expect(cssFontFamilies("   ")).toBeNull();
    expect(cssFontFamilies(" , , ")).toBeNull();
  });

  it("quotes names with spaces and keeps single idents bare", () => {
    expect(cssFontFamilies("Fira Code")).toBe('"Fira Code"');
    expect(cssFontFamilies("monospace")).toBe("monospace");
    expect(cssFontFamilies('"Comic Mono"')).toBe('"Comic Mono"');
  });

  it("normalizes comma-separated lists and strips embedded quotes", () => {
    expect(cssFontFamilies(" Fira Code , Menlo ")).toBe('"Fira Code", Menlo');
    expect(cssFontFamilies('Bad"Name')).toBe('"BadName"');
  });

  it("quotes names that are not single CSS idents", () => {
    expect(cssFontFamilies("3270 Nerd Font")).toBe('"3270 Nerd Font"');
    expect(cssFontFamilies("M+ 1m")).toBe('"M+ 1m"');
  });
});

describe("resolveDefaultFamilyLabel", () => {
  it("skips generic keywords and returns null for a stack of only generics", () => {
    expect(resolveDefaultFamilyLabel("system-ui, sans-serif")).toBeNull();
    expect(resolveDefaultFamilyLabel("ui-monospace, monospace")).toBeNull();
  });
});

describe("appearanceFontStack", () => {
  it("prepends the custom family to the default stack", () => {
    expect(appearanceFontStack("Fira Code", DEFAULT_CODE_FONT_STACK)).toBe(
      `"Fira Code", ${DEFAULT_CODE_FONT_STACK}`,
    );
  });

  it("falls back to the default stack when unset", () => {
    expect(appearanceFontStack("", DEFAULT_SANS_FONT_STACK)).toBe(DEFAULT_SANS_FONT_STACK);
  });
});

describe("resolveTerminalFontPreference", () => {
  it("inherits the code font in simple mode", () => {
    expect(
      resolveTerminalFontPreference({ advanced: false, code: "Fira Code", terminal: "" }),
    ).toBe("Fira Code");
    expect(
      resolveTerminalFontPreference({
        advanced: false,
        code: "Fira Code",
        terminal: "Berkeley Mono",
      }),
    ).toBe("Fira Code");
  });

  it("keeps code and terminal fonts independent in advanced mode", () => {
    expect(resolveTerminalFontPreference({ advanced: true, code: "Fira Code", terminal: "" })).toBe(
      "",
    );
    expect(
      resolveTerminalFontPreference({
        advanced: true,
        code: "Fira Code",
        terminal: "Berkeley Mono",
      }),
    ).toBe("Berkeley Mono");
  });
});

describe("resolveTerminalFontSizePreference", () => {
  it("inherits the code font size in simple mode", () => {
    expect(resolveTerminalFontSizePreference({ advanced: false, code: 15, terminal: 12 })).toBe(15);
  });

  it("keeps code and terminal font sizes independent in advanced mode", () => {
    expect(resolveTerminalFontSizePreference({ advanced: true, code: 15, terminal: 12 })).toBe(12);
  });
});

describe("resolvePromptFontSizePreference", () => {
  it("sizes the prompt like a chosen chat text size in simple mode", () => {
    expect(resolvePromptFontSizePreference({ advanced: false, chat: 17, prompt: 14 })).toBe(17);
  });

  it("keeps the prompt's own size while the chat size is Auto", () => {
    expect(resolvePromptFontSizePreference({ advanced: false, chat: null, prompt: 16 })).toBe(16);
  });

  it("keeps the prompt size independent in advanced mode", () => {
    expect(resolvePromptFontSizePreference({ advanced: true, chat: 17, prompt: 14 })).toBe(14);
    expect(resolvePromptFontSizePreference({ advanced: true, chat: null, prompt: 14 })).toBe(14);
  });
});

describe("applyAppearanceFontVariables", () => {
  function fakeRoot() {
    const properties = new Map<string, string>();
    const style = {
      fontSize: "",
      setProperty: (name: string, value: string) => properties.set(name, value),
      removeProperty: (name: string) => properties.delete(name),
    };
    return { root: { style } as unknown as HTMLElement, style, properties };
  }
  const preferences = {
    sans: "",
    code: "",
    composer: "",
    sizeInterface: 16,
    sizeChat: null,
    sizePrompt: 14,
    sizeCode: 13,
    smoothing: false,
  };

  it("leaves chat text on the interface scale when unset", () => {
    const { root, style, properties } = fakeRoot();
    properties.set("--font-size-chat", "18px");
    applyAppearanceFontVariables(root, { ...preferences, sizeInterface: 18 });
    expect(style.fontSize).toBe("18px");
    expect(properties.has("--font-size-chat")).toBe(false);
    expect(properties.get("--font-size-prompt")).toBe("14px");
  });

  it("sizes chat text independently of the interface", () => {
    const { root, style, properties } = fakeRoot();
    applyAppearanceFontVariables(root, { ...preferences, sizeChat: 17, sizePrompt: 17 });
    expect(style.fontSize).toBe("16px");
    expect(properties.get("--font-size-chat")).toBe("17px");
    expect(properties.get("--font-size-prompt")).toBe("17px");
  });
});

describe("font size clamping", () => {
  it("keeps sizes inside the ranges the UI can absorb", () => {
    expect(clampInterfaceFontSize(16)).toBe(16);
    expect(clampInterfaceFontSize(2)).toBe(12);
    expect(clampInterfaceFontSize(96)).toBe(20);
    expect(clampPromptFontSize(40)).toBe(20);
    expect(clampChatFontSize(8)).toBe(12);
    expect(clampCodeFontSize(1)).toBe(10);
  });

  it("rounds fractional values and falls back for unusable input", () => {
    expect(clampCodeFontSize(13.4)).toBe(13);
    expect(clampInterfaceFontSize(Number.NaN)).toBe(16);
    expect(clampPromptFontSize(Number.POSITIVE_INFINITY)).toBe(14);
  });
});
