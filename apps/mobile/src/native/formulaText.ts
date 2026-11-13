import { markdownMathRanges } from "@t3tools/shared/markdownMath";

/**
 * Markdown for a plain label that typesets its `$` formulas and prints every other character as
 * written. Null when the label has no formula, so it can stay a plain Text.
 */
export function formulaMarkdown(text: string): string | null {
  const formulas = markdownMathRanges(text).filter(({ source }) => source.startsWith("$"));
  if (formulas.length === 0) return null;
  const literal = (value: string) => value.replace(/[!-/:-@[-`{-~]/g, "\\$&");
  let markdown = "";
  let offset = 0;
  for (const formula of formulas) {
    // `\(...\)` opens next to any character; a `$` only opens after whitespace or punctuation.
    markdown += `${literal(text.slice(offset, formula.start))}\\(${formula.tex.replace(/\s+/g, " ")}\\)`;
    offset = formula.end;
  }
  // Leading whitespace as entities, or four spaces would start a code block.
  return (markdown + literal(text.slice(offset))).replace(/^[ \t]+/gm, (indent) =>
    indent.replace(/ /g, "&#32;").replace(/\t/g, "&#9;"),
  );
}
