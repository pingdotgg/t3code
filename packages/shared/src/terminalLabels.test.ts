import { describe, expect, it } from "vite-plus/test";

import type { TerminalSummary } from "@t3tools/contracts";
import { DEFAULT_TERMINAL_ID, TerminalOpenInput } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { getTerminalLabel, nextTerminalId, resolveTerminalSessionLabel } from "./terminalLabels.ts";

const decodeTerminalOpen = Schema.decodeUnknownSync(TerminalOpenInput);

describe("getTerminalLabel", () => {
  it("uses the numeric suffix for term-* ids", () => {
    expect(getTerminalLabel(DEFAULT_TERMINAL_ID)).toBe("Terminal 1");
    expect(getTerminalLabel("term-2")).toBe("Terminal 2");
    expect(getTerminalLabel("term-12")).toBe("Terminal 12");
    expect(getTerminalLabel("terminal-3")).toBe("Terminal 3");
  });

  it("falls back to the raw id for unknown shapes", () => {
    expect(getTerminalLabel("custom-session")).toBe("custom-session");
  });

  it("keeps a numbered label for terminals allocated without host metadata", () => {
    expect(getTerminalLabel("term-2-783c91cc-a413-47c7-8312-c2a5a1f05e40")).toBe("Terminal 2");
  });
});

describe("resolveTerminalSessionLabel", () => {
  it("prefers a non-empty summary label", () => {
    const summary = { label: "  bun  " } as Pick<TerminalSummary, "label">;
    expect(resolveTerminalSessionLabel("term-1", summary)).toBe("bun");
  });

  it("falls back to getTerminalLabel when summary is missing or blank", () => {
    expect(resolveTerminalSessionLabel(DEFAULT_TERMINAL_ID, { label: "   " })).toBe("Terminal 1");
    expect(resolveTerminalSessionLabel(DEFAULT_TERMINAL_ID, null)).toBe("Terminal 1");
    expect(resolveTerminalSessionLabel("term-2", undefined)).toBe("Terminal 2");
  });
});

describe("nextTerminalId", () => {
  it("allocates term-1 when no terminals are listed yet", () => {
    expect(nextTerminalId([])).toBe(DEFAULT_TERMINAL_ID);
  });

  it("allocates term-2 when only term-1 exists", () => {
    expect(nextTerminalId([DEFAULT_TERMINAL_ID])).toBe("term-2");
  });

  it("skips over taken term-N slots", () => {
    expect(nextTerminalId([DEFAULT_TERMINAL_ID, "term-2", "term-3"])).toBe("term-4");
    expect(nextTerminalId([DEFAULT_TERMINAL_ID, "term-3"])).toBe("term-2");
    expect(nextTerminalId(["term-2", "term-3"])).toBe("term-1");
  });

  it("ignores blank/whitespace-only ids", () => {
    expect(nextTerminalId(["", "  ", DEFAULT_TERMINAL_ID])).toBe("term-2");
    expect(nextTerminalId(["", "  "])).toBe("term-1");
  });

  it("avoids unseen sessions when metadata is unavailable and resumes normal numbering", () => {
    const first = nextTerminalId([], "783c91cc-a413-47c7-8312-c2a5a1f05e40");
    const second = nextTerminalId([first], "102315fc-ceef-45c4-b978-c4d4947d3c26");
    expect(first).not.toBe(DEFAULT_TERMINAL_ID);
    expect(second).not.toBe(first);
    expect(getTerminalLabel(second)).toBe("Terminal 2");
    expect(nextTerminalId([first, second])).toBe("term-3");
    expect(
      decodeTerminalOpen({
        threadId: "thread",
        terminalId: second,
        cwd: "/workspace",
      }),
    ).toMatchObject({ terminalId: second });
  });
});
