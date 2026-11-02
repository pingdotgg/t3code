import { getFiletypeFromFileName } from "@pierre/diffs";
import { describe, expect, it } from "vite-plus/test";

import { getSyntaxHighlighterPromise } from "./syntaxHighlighting";
import { DIFF_THEME_NAMES } from "./diffRendering";

describe("dialect file types", () => {
  it.each([
    ["src/init.luau", "lua"],
    ["styles/page.xsl", "xml"],
    ["styles/page.xslt", "xml"],
  ])("%s highlights as %s", (path, language) => {
    expect(getFiletypeFromFileName(path)).toBe(language);
  });
});

const SAMPLES = [
  {
    name: "assembly",
    code: "mov eax, 42 ; answer\nret",
    hints: [
      "asm",
      "assembly",
      "s",
      ...["asm", "ASM", "s", "S", "nasm", "NASM"].map((ext) => `src/start.${ext}`),
    ],
  },
  {
    name: "verilog",
    code: "module top(input wire clk);\n  reg [7:0] q; // count\nendmodule",
    hints: ["verilog", "src/top.v", "src/defs.vh"],
  },
  {
    name: "systemverilog",
    code: "module top(input logic clk);\n  always_ff @(posedge clk) q <= 8'd1; // count\nendmodule",
    hints: ["systemverilog", "system-verilog", "src/top.sv", "src/defs.svh"],
  },
  {
    name: "vhdl",
    code: "entity top is\n  port (clk : in std_logic); -- clock\nend entity;",
    hints: ["vhdl", "src/top.vhd", "src/top.vhdl"],
  },
].flatMap(({ name, code, hints }) => hints.map((hint) => ({ name, code, hint })));

it.each(SAMPLES)("highlights $name in $hint", async ({ code, hint }) => {
  const language = hint.includes("/") ? getFiletypeFromFileName(hint) : hint;
  const highlighter = await getSyntaxHighlighterPromise(language);
  for (const theme of Object.values(DIFF_THEME_NAMES)) {
    const { tokens } = highlighter.codeToTokens(code, { lang: language, theme });
    expect(tokens.map((line) => line.map((token) => token.content).join("")).join("\n")).toBe(code);
    expect(new Set(tokens.flat().map((token) => token.color)).size).toBeGreaterThan(1);
  }
});
