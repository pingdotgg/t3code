import { describe, expect, it } from "vite-plus/test";

import {
  areFontAdvancesMonospace,
  clampCodeFontSize,
  clampInterfaceFontSize,
  clampPromptFontSize,
  createCachedFamilyProbe,
  cssFontFamilies,
  resolveDefaultFamilyLabel,
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

describe("createCachedFamilyProbe", () => {
  it("probes a family once and caches both verdicts", () => {
    const probed: string[] = [];
    const probe = createCachedFamilyProbe(
      (families) => {
        probed.push(families);
        return families.includes("Mono");
      },
      () => true,
    );
    expect(probe("Comic Mono")).toBe(true);
    expect(probe("Comic Mono")).toBe(true);
    expect(probe("Comic Sans MS")).toBe(false);
    expect(probe("Comic Sans MS")).toBe(false);
    expect(probed).toEqual(['"Comic Mono"', '"Comic Sans MS"']);
  });

  it("shares the verdict across spellings of the same family list", () => {
    const probed: string[] = [];
    const probe = createCachedFamilyProbe(
      (families) => {
        probed.push(families);
        return true;
      },
      () => true,
    );
    expect(probe("Fira Code")).toBe(true);
    expect(probe(' "Fira Code" ')).toBe(true);
    expect(probed).toEqual(['"Fira Code"']);
  });

  it("keeps a verdict only once the family resolves", () => {
    let resolved = false;
    let monospace = true;
    let probes = 0;
    const probe = createCachedFamilyProbe(
      () => {
        probes += 1;
        return monospace;
      },
      () => resolved,
    );
    // An absent face measures as the monospace fallback; that pass is not final.
    expect(probe("Late Sans")).toBe(true);
    expect(probe("Late Sans")).toBe(true);
    expect(probes).toBe(2);
    // The real face arrives and turns out proportional: the guard sees it.
    monospace = false;
    resolved = true;
    expect(probe("Late Sans")).toBe(false);
    expect(probe("Late Sans")).toBe(false);
    expect(probes).toBe(3);
  });

  it("waits for every family in a list, not just a resolved fallback", () => {
    let probes = 0;
    const probe = createCachedFamilyProbe(
      () => {
        probes += 1;
        return false;
      },
      (family) => family === "Menlo",
    );
    // Menlo resolves, but the verdict came from it standing in for Late Mono.
    expect(probe("Late Mono, Menlo")).toBe(false);
    expect(probe("Late Mono, Menlo")).toBe(false);
    expect(probes).toBe(2);
    expect(probe("Menlo")).toBe(false);
    expect(probe("Menlo")).toBe(false);
    expect(probes).toBe(3);
  });

  it("accepts empty input without probing", () => {
    const probe = createCachedFamilyProbe(
      () => {
        throw new Error("should not probe");
      },
      () => true,
    );
    expect(probe("")).toBe(true);
    expect(probe("  ")).toBe(true);
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

describe("font size clamping", () => {
  it("keeps sizes inside the ranges the UI can absorb", () => {
    expect(clampInterfaceFontSize(16)).toBe(16);
    expect(clampInterfaceFontSize(2)).toBe(12);
    expect(clampInterfaceFontSize(96)).toBe(20);
    expect(clampPromptFontSize(40)).toBe(20);
    expect(clampCodeFontSize(1)).toBe(10);
  });

  it("rounds fractional values and falls back for unusable input", () => {
    expect(clampCodeFontSize(13.4)).toBe(13);
    expect(clampInterfaceFontSize(Number.NaN)).toBe(16);
    expect(clampPromptFontSize(Number.POSITIVE_INFINITY)).toBe(14);
  });
});
