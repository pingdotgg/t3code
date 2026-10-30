import type { Root } from "mdast";
import type { Processor } from "unified";

import { parseMarkdown } from "./parseMarkdown";

const DOLLAR = 36;

// remark-math registers micromark-extension-llm-math, which owns `$` in text.
function usesMath(extensions: ReadonlyArray<unknown>): boolean {
  return extensions.some((extension) => {
    if (Array.isArray(extension)) return usesMath(extension);
    const text = (extension as { text?: Record<number, unknown> } | null)?.text;
    return text !== undefined && text[DOLLAR] !== undefined;
  });
}

/**
 * Parses with parseMarkdown, which builds the tree remark-parse builds with the chat's syntax
 * extensions. Use after remark-parse and the syntax plugins, so it can see whether math is on.
 */
function attachFastParse(this: Processor) {
  this.parser = (document) =>
    parseMarkdown(document, { math: usesMath(this.data().micromarkExtensions ?? []) }) as Root;
}

export const remarkFastParse = attachFastParse;
