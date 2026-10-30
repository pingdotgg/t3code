import type { Root } from "mdast";
import type { Processor } from "unified";

import { parseMarkdown } from "./parseMarkdown";

const DOLLAR = 36;

// The llm-math tokenizers are not ported yet; their syntax still needs micromark.
function usesMath(extensions: ReadonlyArray<unknown>): boolean {
  return extensions.some((extension) => {
    if (Array.isArray(extension)) return usesMath(extension);
    const text = (extension as { text?: Record<number, unknown> } | null)?.text;
    return text !== undefined && text[DOLLAR] !== undefined;
  });
}

/**
 * Parses with parseMarkdown, which builds the tree remark-parse builds with the chat's syntax
 * extensions. Use after remark-parse and the syntax plugins, so it can see what they need.
 */
function attachFastParse(this: Processor) {
  const fallback = this.parser;
  this.parser = (document) => {
    if (usesMath(this.data().micromarkExtensions ?? []))
      return fallback!(document, undefined as never);
    return parseMarkdown(document) as Root;
  };
}

export const remarkFastParse = attachFastParse;
