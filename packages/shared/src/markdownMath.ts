import { markdownLineEnding } from "micromark-util-character";
import type { State, Tokenizer } from "micromark-util-types";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified, type Processor } from "unified";

declare module "micromark-util-types" {
  interface TokenTypeMap {
    latexMath: "latexMath";
    latexMathData: "latexMathData";
  }
}

// Parse before Markdown's backslash escapes, leaving code spans, fences, and
// link destinations to their own tokenizers. Unclosed delimiters stay text.
const tokenizeLatexMath: Tokenizer = function (effects, ok, nok) {
  let closing: number;
  const start: State = (code) => {
    effects.enter("latexMath");
    effects.enter("latexMathData");
    effects.consume(code);
    return open;
  };
  const open: State = (code) => {
    if (code !== 40 && code !== 91) return nok(code);
    closing = code === 40 ? 41 : 93;
    effects.consume(code);
    return body;
  };
  const body: State = (code) => {
    if (code === null) return nok(code);
    // Micromark uses these tokens to resume list/blockquote containers on the
    // next line; swallowing an EOL as ordinary data breaks nested formulas.
    if (markdownLineEnding(code)) {
      effects.exit("latexMathData");
      effects.enter("lineEnding");
      effects.consume(code);
      effects.exit("lineEnding");
      effects.enter("latexMathData");
      return body;
    }
    effects.consume(code);
    return code === 92 ? escape : body;
  };
  const escape: State = (code) => {
    if (code === closing) {
      effects.consume(code);
      effects.exit("latexMathData");
      effects.exit("latexMath");
      return ok;
    }
    // A doubled backslash is a TeX row separator, not a closing delimiter.
    if (code === 92) {
      effects.consume(code);
      return body;
    }
    return body(code);
  };
  return start;
};

/** Accept agent-authored TeX delimiters and dollar blocks, without treating prices as math. */
function attachChatMath(this: Processor) {
  this.use(remarkMath, { singleDollarTextMath: false });
  const data = this.data();
  (data.micromarkExtensions ??= []).push({
    text: { 92: { name: "latexMath", tokenize: tokenizeLatexMath } },
  });
  (data.fromMarkdownExtensions ??= []).push({
    enter: {
      latexMath(token) {
        const source = this.sliceSerialize(token);
        const value = source.slice(2, -2).trim();
        this.enter(
          {
            type: "inlineMath",
            value,
            data: {
              hName: "code",
              hProperties: {
                className: ["language-math"],
                dataMathDisplay: source.startsWith("\\[") ? "block" : "inline",
              },
              hChildren: [{ type: "text", value }],
            },
          },
          token,
        );
      },
    },
    exit: {
      latexMath(token) {
        this.exit(token);
      },
    },
  });
}

export const remarkChatMath = attachChatMath;

const mathParser = unified().use(remarkParse).use(remarkChatMath).freeze();

export function parseMarkdownWithMath(markdown: string) {
  return mathParser.parse(markdown);
}
