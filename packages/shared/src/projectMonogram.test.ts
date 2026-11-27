import { describe, expect, it } from "vite-plus/test";

import { projectMonogram } from "./projectMonogram.ts";

describe("projectMonogram", () => {
  it("uses two letters for Latin names", () => {
    expect(projectMonogram("Paseo")).toBe("PO");
    expect(projectMonogram("OpenLess")).toBe("OS");
    expect(projectMonogram("Auto Monogram")).toBe("AM");
    expect(projectMonogram("web2 app")).toBe("W2");
    expect(projectMonogram("Café Ünïcode")).toBe("CÜ");
  });

  it("uses one character for CJK names", () => {
    expect(projectMonogram("健康顾问")).toBe("健");
    expect(projectMonogram("定时任务与编排")).toBe("定");
    expect(projectMonogram("ひらがな")).toBe("ひ");
    expect(projectMonogram("カタカナ")).toBe("カ");
    expect(projectMonogram("건강 상담")).toBe("건");
    expect(projectMonogram("〆切管理")).toBe("〆");
    expect(projectMonogram("ー長")).toBe("ー");
  });

  it("normalizes width and keeps supplementary ideographs whole", () => {
    expect(projectMonogram("ｶﾞﾅ")).toBe("ガ");
    expect(projectMonogram("𠮷野家")).toBe("𠮷");
  });

  it("keys mixed names on their first letter or number", () => {
    expect(projectMonogram("健康App")).toBe("健");
    expect(projectMonogram("  健康 Paseo")).toBe("健");
    expect(projectMonogram("Paseo 健康")).toBe("P健");
    expect(projectMonogram("AI助手")).toBe("A手");
  });

  it("falls back when the name has no letters or digits", () => {
    expect(projectMonogram("")).toBe("PR");
    expect(projectMonogram("—")).toBe("PR");
  });
});
