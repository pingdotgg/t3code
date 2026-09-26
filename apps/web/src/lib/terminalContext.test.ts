import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { collectComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import { terminalContextRecord } from "./composerContextRecords";

import {
  filterTerminalContextsWithText,
  formatTerminalContextLabel,
  formatTerminalContextReference,
  hasTerminalContextText,
  INLINE_TERMINAL_CONTEXT_PLACEHOLDER,
  isTerminalContextExpired,
  migrateLegacyTerminalContextPlaceholders,
  type TerminalContextDraft,
} from "./terminalContext";

function makeContext(overrides?: Partial<TerminalContextDraft>): TerminalContextDraft {
  return {
    id: "context-1",
    threadId: ThreadId.make("thread-1"),
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
  it("folds legacy producer ids consistently in records and references", () => {
    const context = makeContext({ id: "old terminal:one" });
    const reference = collectComposerContextReferences(formatTerminalContextReference(context))[0];
    expect(reference).toBeDefined();
    expect(reference?.contextId).toBe(terminalContextRecord(context).contextId);
  });
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

  it("formats a terminal context as a canonical reference link", () => {
    expect(formatTerminalContextReference(makeContext())).toBe(
      "[Terminal 1 lines 12-13](t3-context://v1/terminal/terminal_context-1)",
    );
  });

  it("migrates legacy placeholders to references in order and drops extras", () => {
    const placeholder = INLINE_TERMINAL_CONTEXT_PLACEHOLDER;
    const first = formatTerminalContextReference(makeContext());
    const contexts = [makeContext()];
    expect(
      migrateLegacyTerminalContextPlaceholders(`a ${placeholder} b ${placeholder}`, contexts),
    ).toBe(`a ${first} b `);
    expect(migrateLegacyTerminalContextPlaceholders("plain", contexts)).toBe("plain");
  });

  it("marks contexts without snapshot text as expired and filters them from sendable contexts", () => {
    const liveContext = makeContext();
    const expiredContext = makeContext({
      id: "context-2",
      text: "",
    });

    expect(hasTerminalContextText(liveContext)).toBe(true);
    expect(isTerminalContextExpired(liveContext)).toBe(false);
    expect(hasTerminalContextText(expiredContext)).toBe(false);
    expect(isTerminalContextExpired(expiredContext)).toBe(true);
    expect(filterTerminalContextsWithText([expiredContext, liveContext])).toEqual([liveContext]);
  });
});
