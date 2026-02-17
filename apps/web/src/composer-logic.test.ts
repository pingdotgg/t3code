import { describe, expect, it } from "vitest";

import {
  buildPromptInput,
  buildUserVisiblePrompt,
  detectComposerTrigger,
  replaceTextRange,
} from "./composer-logic";

describe("detectComposerTrigger", () => {
  it("detects @path trigger at cursor", () => {
    const text = "Please check @src/com";
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toEqual({
      kind: "path",
      query: "src/com",
      rangeStart: "Please check ".length,
      rangeEnd: text.length,
    });
  });

  it("detects slash command token while typing command name", () => {
    const text = "/mo";
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toEqual({
      kind: "slash-command",
      query: "mo",
      rangeStart: 0,
      rangeEnd: text.length,
    });
  });

  it("detects slash model query after /model", () => {
    const text = "/model spark";
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toEqual({
      kind: "slash-model",
      query: "spark",
      rangeStart: 0,
      rangeEnd: text.length,
    });
  });
});

describe("replaceTextRange", () => {
  it("replaces a text range and returns new cursor", () => {
    const replaced = replaceTextRange("hello @src", 6, 10, "");
    expect(replaced).toEqual({
      text: "hello ",
      cursor: 6,
    });
  });
});

describe("tagged path prompt helpers", () => {
  it("builds model input with tagged paths", () => {
    const result = buildPromptInput("Fix this", ["src/app.tsx", "src/app.tsx", "README.md"]);
    expect(result).toContain("Fix this");
    expect(result).toContain("Referenced paths:");
    expect(result).toContain("- src/app.tsx");
    expect(result).toContain("- README.md");
    expect(result).not.toContain("- src/app.tsx\n- src/app.tsx");
  });

  it("builds user-visible prompt from tags only", () => {
    const result = buildUserVisiblePrompt("  ", ["src/app.tsx", "README.md"]);
    expect(result).toBe("@src/app.tsx @README.md");
  });
});
