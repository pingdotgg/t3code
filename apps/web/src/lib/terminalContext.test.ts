import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  appendTerminalContextsToPrompt,
  buildTerminalContextBlock,
  extractTrailingTerminalContexts,
  formatTerminalContextLabel,
  type TerminalContextDraft,
} from "./terminalContext";

function makeContext(overrides?: Partial<TerminalContextDraft>): TerminalContextDraft {
  return {
    id: "context-1",
    threadId: ThreadId.makeUnsafe("thread-1"),
    terminalId: "default",
    terminalLabel: "Terminal 1",
    lineStart: 12,
    lineEnd: 13,
    text: "git status\nOn branch main",
    createdAt: "2026-03-13T12:00:00.000Z",
    ...overrides,
  };
}

describe("terminalContext", () => {
  it("formats terminal labels with line ranges", () => {
    expect(formatTerminalContextLabel(makeContext())).toBe("Terminal 1 lines 12-13");
    expect(
      formatTerminalContextLabel(
        makeContext({
          lineStart: 9,
          lineEnd: 9,
        }),
      ),
    ).toBe("Terminal 1 line 9");
  });

  it("builds a numbered terminal context block", () => {
    expect(buildTerminalContextBlock([makeContext()])).toBe(
      [
        "<terminal_context>",
        "- Terminal 1 lines 12-13:",
        "  12 | git status",
        "  13 | On branch main",
        "</terminal_context>",
      ].join("\n"),
    );
  });

  it("appends terminal context blocks after prompt text", () => {
    expect(appendTerminalContextsToPrompt("Investigate this", [makeContext()])).toBe(
      [
        "Investigate this",
        "",
        "<terminal_context>",
        "- Terminal 1 lines 12-13:",
        "  12 | git status",
        "  13 | On branch main",
        "</terminal_context>",
      ].join("\n"),
    );
  });

  it("extracts terminal context blocks from message text", () => {
    const prompt = appendTerminalContextsToPrompt("Investigate this", [makeContext()]);
    expect(extractTrailingTerminalContexts(prompt)).toEqual({
      promptText: "Investigate this",
      contextCount: 1,
      previewTitle: "Terminal 1 lines 12-13\n12 | git status\n13 | On branch main",
    });
  });

  it("preserves prompt text when no trailing terminal context block exists", () => {
    expect(extractTrailingTerminalContexts("No attached context")).toEqual({
      promptText: "No attached context",
      contextCount: 0,
      previewTitle: null,
    });
  });
});
