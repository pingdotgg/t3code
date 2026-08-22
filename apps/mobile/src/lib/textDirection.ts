export type TextDirection = "ltr" | "rtl";

const LETTER_CHARACTER = /^\p{Letter}$/u;
const RTL_SCRIPT_CHARACTER =
  /^[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufeff\u{10800}-\u{10fff}\u{1e800}-\u{1eeff}]$/u;
const MARKDOWN_CODE = /```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`/g;

export function resolveTextDirection(text: string): TextDirection {
  for (const character of text) {
    if (!LETTER_CHARACTER.test(character)) continue;
    return RTL_SCRIPT_CHARACTER.test(character) ? "rtl" : "ltr";
  }
  return "ltr";
}

export function resolveMarkdownTextDirection(markdown: string): TextDirection {
  return resolveTextDirection(markdown.replace(MARKDOWN_CODE, ""));
}
