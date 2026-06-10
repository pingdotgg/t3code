import { describe, expect, it } from "vitest";

import type { TerminalSummary } from "@t3tools/contracts";

import { getTerminalLabel, nextTerminalId, resolveTerminalSessionLabel } from "./terminalLabels.ts";

describe("getTerminalLabel", () => {
  it("uses the numeric suffix for term-* ids", () => {
    expect(getTerminalLabel("term-1")).toBe("Terminal 1");
    expect(getTerminalLabel("term-2")).toBe("Terminal 2");
    expect(getTerminalLabel("term-12")).toBe("Terminal 12");
    expect(getTerminalLabel("terminal-3")).toBe("Terminal 3");
  });

  it("falls back to the raw id for unknown shapes", () => {
    expect(getTerminalLabel("custom-session")).toBe("custom-session");
  });
});

describe("resolveTerminalSessionLabel", () => {
  it("prefers a non-empty summary label", () => {
    const summary = { label: "  bun  " } as Pick<TerminalSummary, "label">;
    expect(resolveTerminalSessionLabel("term-1", summary)).toBe("bun");
  });

  it("falls back to getTerminalLabel when summary is missing or blank", () => {
    expect(resolveTerminalSessionLabel("term-1", { label: "   " })).toBe("Terminal 1");
    expect(resolveTerminalSessionLabel("term-1", null)).toBe("Terminal 1");
    expect(resolveTerminalSessionLabel("term-2", undefined)).toBe("Terminal 2");
  });
});

describe("nextTerminalId", () => {
  it("allocates term-1 when no terminals are listed yet", () => {
    expect(nextTerminalId([])).toBe("term-1");
  });

  it("allocates term-2 when only term-1 exists", () => {
    expect(nextTerminalId(["term-1"])).toBe("term-2");
  });

  it("skips over taken term-N slots", () => {
    expect(nextTerminalId(["term-1", "term-2", "term-3"])).toBe("term-4");
    expect(nextTerminalId(["term-1", "term-3"])).toBe("term-2");
    expect(nextTerminalId(["term-2", "term-3"])).toBe("term-1");
  });

  it("ignores blank/whitespace-only ids", () => {
    expect(nextTerminalId(["", "  ", "term-1"])).toBe("term-2");
    expect(nextTerminalId(["", "  "])).toBe("term-1");
  });
});
