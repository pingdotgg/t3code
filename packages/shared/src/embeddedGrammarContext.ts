/**
 * Diff hunks are tokenized without the file above them, so a hunk inside a component's `<script>`
 * starts in the grammar's top-level markup state and its code comes out uncolored. These are the
 * openers fed to the tokenizer as `grammarContextCode` to start it inside the right block.
 */
const SCRIPT_CONTEXT_BY_LANGUAGE: Partial<Record<string, string>> = {
  svelte: '<script lang="ts">\n',
};

const STYLE_CONTEXT = "<style>\n";
// A style hunk that closes a rule before opening one starts among that rule's declarations.
const STYLE_RULE_CONTEXT = "<style>\n* {\n";
const CLOSING_SCRIPT = /^\s*<\/script\s*>/i;
const CLOSING_STYLE = /^\s*<\/style\s*>/i;
const MARKUP = /^\s*(?:<[A-Za-z!/]|\{[#:/@])/;
const BRACE = /[{}]/;

/**
 * The block a hunk most likely starts inside, as context to tokenize it with, or `undefined` when
 * the top-level state is already right. Reads the hunk's lines until the first one that gives the
 * block away; with none, a hunk past the top of a component file is almost always script.
 */
export function inferEmbeddedGrammarContext(
  language: string,
  firstLineNumber: number,
  lines: Iterable<string>,
) {
  const scriptContext = SCRIPT_CONTEXT_BY_LANGUAGE[language];
  if (scriptContext === undefined || firstLineNumber <= 1) return undefined;
  let firstBrace: string | undefined;
  for (const line of lines) {
    if (CLOSING_SCRIPT.test(line)) return scriptContext;
    if (CLOSING_STYLE.test(line)) return firstBrace === "}" ? STYLE_RULE_CONTEXT : STYLE_CONTEXT;
    if (MARKUP.test(line)) return undefined;
    firstBrace ??= BRACE.exec(line)?.[0];
  }
  return scriptContext;
}
