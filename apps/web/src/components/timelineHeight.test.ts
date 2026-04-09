import { describe, expect, it } from "vitest";

import { appendTerminalContextsToPrompt } from "../lib/terminalContext";
import { DEFAULT_TYPOGRAPHY_SETTINGS } from "../typography";
import { buildInlineTerminalContextText } from "./chat/userMessageTerminalContexts";
import { estimateTimelineMessageHeight } from "./timelineHeight";

describe("estimateTimelineMessageHeight", () => {
  it("uses assistant sizing rules for assistant messages", () => {
    expect(
      estimateTimelineMessageHeight({
        role: "assistant",
        text: "a".repeat(144),
      }),
    ).toBe(86.5);
  });

  it("uses assistant sizing rules for system messages", () => {
    expect(
      estimateTimelineMessageHeight({
        role: "system",
        text: "a".repeat(144),
      }),
    ).toBe(86.5);
  });

  it("adds one attachment row for one or two user attachments", () => {
    expect(
      estimateTimelineMessageHeight({
        role: "user",
        text: "hello",
        attachments: [{ id: "1" }],
      }),
    ).toBe(233);

    expect(
      estimateTimelineMessageHeight({
        role: "user",
        text: "hello",
        attachments: [{ id: "1" }, { id: "2" }],
      }),
    ).toBe(233);
  });

  it("adds a second attachment row for three or four user attachments", () => {
    expect(
      estimateTimelineMessageHeight({
        role: "user",
        text: "hello",
        attachments: [{ id: "1" }, { id: "2" }, { id: "3" }],
      }),
    ).toBe(349);

    expect(
      estimateTimelineMessageHeight({
        role: "user",
        text: "hello",
        attachments: [{ id: "1" }, { id: "2" }, { id: "3" }, { id: "4" }],
      }),
    ).toBe(349);
  });

  it("does not cap long user message estimates", () => {
    expect(
      estimateTimelineMessageHeight({
        role: "user",
        text: "a".repeat(56 * 120),
      }),
    ).toBe(2301);
  });

  it("counts explicit newlines for user message estimates", () => {
    expect(
      estimateTimelineMessageHeight({
        role: "user",
        text: "first\nsecond\nthird",
      }),
    ).toBe(159);
  });

  it("adds terminal context chrome without counting the hidden block as message text", () => {
    const prompt = appendTerminalContextsToPrompt("Investigate this", [
      {
        terminalId: "default",
        terminalLabel: "Terminal 1",
        lineStart: 40,
        lineEnd: 43,
        text: [
          "git status",
          "M apps/web/src/components/chat/MessagesTimeline.tsx",
          "?? tmp",
          "",
        ].join("\n"),
      },
    ]);

    expect(
      estimateTimelineMessageHeight({
        role: "user",
        text: prompt,
      }),
    ).toBe(
      estimateTimelineMessageHeight({
        role: "user",
        text: `${buildInlineTerminalContextText([{ header: "Terminal 1 lines 40-43" }])} Investigate this`,
      }),
    );
  });

  it("uses narrower width to increase user line wrapping", () => {
    const message = {
      role: "user" as const,
      text: "a".repeat(52),
    };

    expect(estimateTimelineMessageHeight(message, { timelineWidthPx: 320 })).toBe(138);
    expect(estimateTimelineMessageHeight(message, { timelineWidthPx: 768 })).toBe(117);
  });

  it("does not clamp user wrapping too aggressively on very narrow layouts", () => {
    const message = {
      role: "user" as const,
      text: "a".repeat(20),
    };

    expect(estimateTimelineMessageHeight(message, { timelineWidthPx: 100 })).toBe(180);
    expect(estimateTimelineMessageHeight(message, { timelineWidthPx: 320 })).toBe(117);
  });

  it("lets user message typography change wrapping estimates", () => {
    const message = {
      role: "user" as const,
      text: "a".repeat(53),
    };

    expect(
      estimateTimelineMessageHeight(message, {
        timelineWidthPx: 320,
        typography: {
          ...DEFAULT_TYPOGRAPHY_SETTINGS,
          userMessageFont: "monospace",
        },
      }),
    ).toBe(159);

    expect(
      estimateTimelineMessageHeight(message, {
        timelineWidthPx: 320,
        typography: {
          ...DEFAULT_TYPOGRAPHY_SETTINGS,
          userMessageFont: "sans",
        },
      }),
    ).toBe(141.5);
  });

  it("lets code font size change monospace user message estimates", () => {
    const message = {
      role: "user" as const,
      text: "a".repeat(53),
    };

    expect(
      estimateTimelineMessageHeight(message, {
        timelineWidthPx: 320,
        typography: {
          ...DEFAULT_TYPOGRAPHY_SETTINGS,
          userMessageFont: "monospace",
          codeFontSize: "12px",
        },
      }),
    ).toBe(132);
  });

  it("uses narrower width to increase assistant line wrapping", () => {
    const message = {
      role: "assistant" as const,
      text: "a".repeat(200),
    };

    expect(estimateTimelineMessageHeight(message, { timelineWidthPx: 320 })).toBe(154.75);
    expect(estimateTimelineMessageHeight(message, { timelineWidthPx: 768 })).toBe(86.5);
  });
});
