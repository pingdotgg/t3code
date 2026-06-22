import { describe, expect, it } from "bun:test";

import { allIconGlyphs, fileTypeColor, STATUS_ICONS, TOOL_ICONS } from "./icons.ts";
import { THREAD_STATUS_GLYPHS } from "./theme.ts";

describe("icon registry", () => {
  it("Given every tool/status glyph, then each is exactly one display column", () => {
    // A terminal can only render whole columns; a two-column glyph (most emoji)
    // would shear every aligned row. This is the gate behind "hybrid safe emoji".
    for (const { glyph, webIcon } of allIconGlyphs()) {
      expect(Bun.stringWidth(glyph)).toBe(1);
      expect(webIcon.length).toBeGreaterThan(0);
    }
  });

  it("Given every thread-status dot, then each is exactly one display column", () => {
    for (const glyph of THREAD_STATUS_GLYPHS) {
      expect(Bun.stringWidth(glyph)).toBe(1);
    }
  });

  it("Given the tool icons, then each documents the web lucide icon it mirrors", () => {
    expect(TOOL_ICONS.terminal.webIcon).toBe("terminal");
    expect(TOOL_ICONS.fileRead.webIcon).toBe("eye");
    expect(TOOL_ICONS.fileChange.webIcon).toBe("square-pen");
    expect(TOOL_ICONS.webSearch.webIcon).toBe("globe");
    expect(TOOL_ICONS.mcp.webIcon).toBe("wrench");
    expect(TOOL_ICONS.dynamic.webIcon).toBe("hammer");
  });

  it("Given the status icons, then they mirror the web Check / X / loader / Minus", () => {
    expect(STATUS_ICONS.success.webIcon).toBe("check");
    expect(STATUS_ICONS.failure.webIcon).toBe("x");
    expect(STATUS_ICONS.progress.webIcon).toBe("loader");
    expect(STATUS_ICONS.neutral.webIcon).toBe("minus");
  });

  it("Given a file path, then fileTypeColor maps its extension (and dims the unknown)", () => {
    expect(fileTypeColor("src/app.ts")).toBe("blue");
    expect(fileTypeColor("README.md")).toBe("cyan");
    expect(fileTypeColor("style.css")).toBe("magenta");
    expect(fileTypeColor("Makefile")).toBeNull();
    expect(fileTypeColor("weird.unknownext")).toBeNull();
  });
});
