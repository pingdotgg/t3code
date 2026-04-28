import { ThreadId } from "@forma/contracts";
import { describe, expect, it } from "vitest";

import {
  appendCodeContextsToPrompt,
  buildCodeContextBlock,
  buildCodeContextPreviewTitle,
  countInlineCodeContextPlaceholders,
  ensureInlineCodeContextPlaceholders,
  extractTrailingCodeContexts,
  formatCodeContextLabel,
  formatInlineCodeContextLabel,
  getCodeContextSelectionLimitMessage,
  INLINE_CODE_CONTEXT_PLACEHOLDER,
  insertInlineCodeContextPlaceholder,
  materializeInlineCodeContextPrompt,
  normalizeCodeContextSelection,
  removeInlineCodeContextPlaceholder,
  stripInlineCodeContextPlaceholders,
  type CodeContextDraft,
} from "./codeContext";

function makeContext(overrides?: Partial<CodeContextDraft>): CodeContextDraft {
  return {
    id: "code-context-1",
    threadId: ThreadId.make("thread-1"),
    filePath: "src/components/SplashScreen.tsx",
    lineStart: 12,
    lineEnd: 14,
    text: "export function SplashScreen() {\n  return <div />;\n}",
    createdAt: "2026-04-27T12:00:00.000Z",
    ...overrides,
  };
}

describe("codeContext", () => {
  it("normalizes selected code text and derives line end from the normalized text", () => {
    expect(
      normalizeCodeContextSelection({
        filePath: " src/example.ts ",
        lineStart: 7,
        lineEnd: 20,
        text: "\r\nconst a = 1;\r\nconst b = 2;\r\n",
      }),
    ).toEqual({
      filePath: "src/example.ts",
      lineStart: 7,
      lineEnd: 8,
      text: "const a = 1;\nconst b = 2;",
    });
  });

  it("formats code labels and inline labels with singular and plural ranges", () => {
    expect(formatCodeContextLabel(makeContext())).toBe(
      "src/components/SplashScreen.tsx lines 12-14",
    );
    expect(
      formatCodeContextLabel(
        makeContext({
          lineStart: 9,
          lineEnd: 9,
        }),
      ),
    ).toBe("src/components/SplashScreen.tsx line 9");
    expect(formatInlineCodeContextLabel(makeContext())).toBe(
      "#src/components/SplashScreen.tsx:12-14",
    );
  });

  it("builds and appends numbered code context blocks", () => {
    expect(buildCodeContextBlock([makeContext()])).toBe(
      [
        "<code_context>",
        "- src/components/SplashScreen.tsx lines 12-14:",
        "  12 | export function SplashScreen() {",
        "  13 |   return <div />;",
        "  14 | }",
        "</code_context>",
      ].join("\n"),
    );
    expect(appendCodeContextsToPrompt("Inspect this", [makeContext()])).toBe(
      [
        "Inspect this",
        "",
        "<code_context>",
        "- src/components/SplashScreen.tsx lines 12-14:",
        "  12 | export function SplashScreen() {",
        "  13 |   return <div />;",
        "  14 | }",
        "</code_context>",
      ].join("\n"),
    );
  });

  it("materializes inline code labels before appending trailing blocks", () => {
    expect(
      appendCodeContextsToPrompt(`Inspect ${INLINE_CODE_CONTEXT_PLACEHOLDER} carefully`, [
        makeContext(),
      ]),
    ).toBe(
      [
        "Inspect #src/components/SplashScreen.tsx:12-14 carefully",
        "",
        "<code_context>",
        "- src/components/SplashScreen.tsx lines 12-14:",
        "  12 | export function SplashScreen() {",
        "  13 |   return <div />;",
        "  14 | }",
        "</code_context>",
      ].join("\n"),
    );
    expect(
      materializeInlineCodeContextPrompt(`Inspect ${INLINE_CODE_CONTEXT_PLACEHOLDER} carefully`, [
        makeContext(),
      ]),
    ).toBe("Inspect #src/components/SplashScreen.tsx:12-14 carefully");
  });

  it("extracts trailing code context blocks", () => {
    const prompt = appendCodeContextsToPrompt("Inspect this", [makeContext()]);
    expect(extractTrailingCodeContexts(prompt)).toEqual({
      promptText: "Inspect this",
      contextCount: 1,
      previewTitle:
        "src/components/SplashScreen.tsx lines 12-14\n12 | export function SplashScreen() {\n13 |   return <div />;\n14 | }",
      contexts: [
        {
          header: "src/components/SplashScreen.tsx lines 12-14",
          filePath: "src/components/SplashScreen.tsx",
          lineStart: 12,
          lineEnd: 14,
          body: "12 | export function SplashScreen() {\n13 |   return <div />;\n14 | }",
        },
      ],
    });
  });

  it("tracks inline code context placeholders in prompt text", () => {
    const placeholder = INLINE_CODE_CONTEXT_PLACEHOLDER;
    expect(countInlineCodeContextPlaceholders(`a${placeholder}b${placeholder}`)).toBe(2);
    expect(ensureInlineCodeContextPlaceholders("Inspect this", 2)).toBe(
      `${placeholder}${placeholder}Inspect this`,
    );
    expect(insertInlineCodeContextPlaceholder("abc", 1)).toEqual({
      prompt: `a ${placeholder} bc`,
      cursor: 4,
      contextIndex: 0,
    });
    expect(removeInlineCodeContextPlaceholder(`a${placeholder}b${placeholder}c`, 1)).toEqual({
      prompt: `a${placeholder}bc`,
      cursor: 3,
    });
    expect(stripInlineCodeContextPlaceholders(`a${placeholder}b`)).toBe("ab");
  });

  it("builds preview titles and enforces selection size limits", () => {
    expect(buildCodeContextPreviewTitle([makeContext()])).toContain(
      "src/components/SplashScreen.tsx lines 12-14",
    );
    expect(
      getCodeContextSelectionLimitMessage({
        text: Array.from({ length: 201 }, (_, index) => `line ${index + 1}`).join("\n"),
      }),
    ).toBe("Selections are limited to 200 lines or 12,000 characters.");
  });
});
