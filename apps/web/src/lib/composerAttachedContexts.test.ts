import { describe, expect, it } from "vitest";

import { appendCodeContextsToPrompt } from "./codeContext";
import { deriveDisplayedUserMessageState } from "./composerAttachedContexts";
import { appendTerminalContextsToPrompt } from "./terminalContext";

describe("deriveDisplayedUserMessageState", () => {
  it("strips a trailing terminal context block while preserving copy text", () => {
    const prompt = appendTerminalContextsToPrompt("Inspect this", [
      {
        terminalId: "default",
        terminalLabel: "Terminal 1",
        lineStart: 4,
        lineEnd: 4,
        text: "git status",
      },
    ]);

    expect(deriveDisplayedUserMessageState(prompt)).toMatchObject({
      visibleText: "Inspect this",
      copyText: prompt,
      contextCount: 1,
      terminalContexts: [{ header: "Terminal 1 line 4" }],
      codeContexts: [],
    });
  });

  it("strips a trailing code context block while preserving copy text", () => {
    const prompt = appendCodeContextsToPrompt("Inspect this", [
      {
        filePath: "src/example.ts",
        lineStart: 7,
        lineEnd: 8,
        text: "const a = 1;\nconst b = 2;",
      },
    ]);

    expect(deriveDisplayedUserMessageState(prompt)).toMatchObject({
      visibleText: "Inspect this",
      copyText: prompt,
      contextCount: 1,
      terminalContexts: [],
      codeContexts: [{ filePath: "src/example.ts", lineStart: 7, lineEnd: 8 }],
    });
  });

  it("strips both trailing blocks in send order", () => {
    const promptWithTerminal = appendTerminalContextsToPrompt("Inspect this", [
      {
        terminalId: "default",
        terminalLabel: "Terminal 1",
        lineStart: 4,
        lineEnd: 4,
        text: "git status",
      },
    ]);
    const prompt = appendCodeContextsToPrompt(promptWithTerminal, [
      {
        filePath: "src/example.ts",
        lineStart: 7,
        lineEnd: 8,
        text: "const a = 1;\nconst b = 2;",
      },
    ]);

    expect(deriveDisplayedUserMessageState(prompt)).toMatchObject({
      visibleText: "Inspect this",
      contextCount: 2,
      terminalContexts: [{ header: "Terminal 1 line 4" }],
      codeContexts: [{ filePath: "src/example.ts" }],
    });
  });
});
