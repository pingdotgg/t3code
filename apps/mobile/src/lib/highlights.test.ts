import { codeToTokens } from "@pierre/highlights";
import { pierreDark, pierreLight } from "@pierre/highlights/themes";
import { describe, expect, it, vi } from "vite-plus/test";

import { highlightCode, tokenizeCode } from "./highlights";

vi.mock("expo", async () => {
  const { createWasmHighlightsModule } = await import("./highlights.testing");
  const highlights = createWasmHighlightsModule();
  return { requireOptionalNativeModule: () => highlights };
});

describe("highlightCode", () => {
  it("produces @pierre/highlights' own tokens and colors", () => {
    const code = [
      "/** 🎉 docs\r",
      " */",
      "export const greet = (name: string) => <b title={`hi ${name}`}>é</b>;",
      "const multi = `first",
      "second`; // done",
      "",
    ].join("\n");

    for (const [scheme, theme] of [
      ["light", pierreLight],
      ["dark", pierreDark],
    ] as const) {
      const expected = codeToTokens(code, { lang: "tsx", theme }).tokens.map((line) =>
        line.map((token) => ({
          content: token.content,
          color: token.color ?? null,
          fontStyle: token.fontStyle ?? null,
        })),
      );
      expect(highlightCode(code, "tsx", scheme)).toEqual(expected);
    }
  });

  it("keeps an over-long line as one plain token", () => {
    const longLine = `const data = "${"x".repeat(1_000)}";`;
    const [first, second] = highlightCode(`let a = 1;\n${longLine}`, "typescript", "dark");

    expect(first?.length).toBeGreaterThan(1);
    expect(second).toEqual([{ content: longLine, color: null, fontStyle: null }]);
  });
});

it("normalizes only requested lines from full-source records, including CRLF and a long comment opener", () => {
  const code = `const first = 1;\r\n${" ".repeat(1_001)}/*\r\ninside\r\n*/\r\nconst last = 2;`;
  const source = tokenizeCode(code, "typescript");
  expect(source.byteLength).toBeGreaterThan(0);
  for (let line = 0; line < 5; line++) {
    expect(source.highlightLine(line, "dark")).toEqual(
      highlightCode(code, "typescript", "dark")[line],
    );
  }
  expect(source.highlightLine(2, "dark")?.[0]?.color).toBe("#737373");
  expect(source.highlightLine(100, "dark")).toBeUndefined();
});
