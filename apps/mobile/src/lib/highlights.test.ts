import { codeToTokens } from "@pierre/highlights";
import { pierreDark, pierreLight } from "@pierre/highlights/themes";
import { describe, expect, it, vi } from "vite-plus/test";

import { resolveHighlightLanguage } from "./highlightLanguage";
import { highlightCode, tokenizeCode } from "./highlights";
import {
  boundedSelectableSourceTokens,
  prepareSourceFileDocument,
} from "../features/files/source-file-document";

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

it.each([
  "asm",
  "assembly",
  "s",
  ...["asm", "ASM", "s", "S", "nasm", "NASM"].map((ext) => `src/start.${ext}`),
])("highlights assembly in %s", (hint) => {
  const language = resolveHighlightLanguage(
    hint.includes("/") ? { path: hint } : { language: hint },
  );
  const code = "mov eax, 42 ; answer\nret";
  for (const scheme of ["light", "dark"] as const) {
    const tokens = highlightCode(code, language, scheme);
    expect(tokens.map((line) => line.map((token) => token.content).join("")).join("\n")).toBe(code);
    expect(new Set(tokens.flat().map((token) => token.color)).size).toBeGreaterThan(1);
  }
});

it.each([
  ["empty", ""],
  ["trailing LF", "const x = 1;\n"],
  ["blank lines", "\n\n\n"],
  ["CRLF", "const x = 1;\r\n\r\nconst y = 2;\r\n"],
  ["CR", "const x = 1;\r\rconst y = 2;\r"],
  ["Unicode", "const café = '🎉 é';\nconst 行 = '\u2028\u2029';\n"],
  ["long lines", `const x = "${"🎉é".repeat(1_001)}";\n\n`],
  ["threshold blank", "\n".repeat(1_999)],
  ["over threshold blank", "\n".repeat(2_000)],
  [
    "over threshold code",
    Array.from({ length: 2_001 }, (_, i) => `const café${i} = '🎉';`).join("\r\n"),
  ],
])("preserves the normalized document line bound with real WASM records: %s", (_name, contents) => {
  const document = prepareSourceFileDocument(contents);
  for (const theme of ["light", "dark"] as const) {
    const source = tokenizeCode(document.contents, "typescript");
    const tokens = highlightCode(document.contents, "typescript", theme);
    expect(source.lineCount).toBe(document.lines.length);
    expect(tokens).toHaveLength(document.lines.length);
    expect(tokens.map((line) => line.map((token) => token.content).join("")).join("\n")).toBe(
      document.contents,
    );
    if (document.lines.length > 2_000) expect(boundedSelectableSourceTokens(tokens)).toBeNull();
  }
});
