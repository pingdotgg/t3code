import { createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { vscode } from "../theme.ts";

/** One colour per character of the source (newlines included). */
export type Colors = string[];

const languages: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  json: "json",
  html: "html",
  css: "css",
};

export const languageOf = (file: string): string | undefined =>
  languages[file.split(".").pop() ?? ""];

export const languageLabel = (file: string): string =>
  ({
    typescript: "TypeScript",
    tsx: "TypeScript JSX",
    javascript: "JavaScript",
    json: "JSON",
    html: "HTML",
    css: "CSS",
  })[languageOf(file) ?? ""] ?? "Plain Text";

let highlighter: Promise<HighlighterCore> | undefined;
const getHighlighter = () =>
  (highlighter ??= createHighlighterCore({
    themes: [import("shiki/themes/dark-plus.mjs")],
    langs: [
      import("shiki/langs/typescript.mjs"),
      import("shiki/langs/tsx.mjs"),
      import("shiki/langs/javascript.mjs"),
      import("shiki/langs/json.mjs"),
      import("shiki/langs/html.mjs"),
      import("shiki/langs/css.mjs"),
    ],
    engine: createJavaScriptRegexEngine(),
  }));

/** Per-character colours of `code` in VS Code's Dark+ token colours. */
export const highlight = async (file: string, code: string): Promise<Colors> => {
  const lang = languageOf(file);
  if (!lang) return Array.from(code, () => vscode.fg);
  const { tokens } = (await getHighlighter()).codeToTokens(code, {
    lang,
    theme: "dark-plus",
  });
  const colors: Colors = [];
  tokens.forEach((line, index) => {
    for (const token of line) {
      for (let i = 0; i < token.content.length; i++) colors.push(token.color ?? vscode.fg);
    }
    if (index < tokens.length - 1) colors.push(vscode.fg);
  });
  // Shiki normalises line endings; pad defensively so indexes always resolve.
  while (colors.length < code.length) colors.push(vscode.fg);
  return colors;
};
