import type { Literal, Root } from "mdast";
import { markdownLineEnding, markdownSpace } from "micromark-util-character";
import type { Code, Construct, State, Tokenizer } from "micromark-util-types";
import remarkParse from "remark-parse";
import { unified, type Processor } from "unified";

export interface MarkdownMath {
  readonly source: string;
  readonly tex: string;
  readonly display: boolean;
}

interface MathNode extends Literal {
  type: "inlineMath";
  data: {
    math: MarkdownMath | null;
    hName: "span";
    hProperties: { dataMathSource: string };
  };
}

declare module "mdast" {
  interface RootContentMap {
    inlineMath: MathNode;
  }
  interface PhrasingContentMap {
    inlineMath: MathNode;
  }
}

declare module "micromark-util-types" {
  interface TokenTypeMap {
    t3Math: "t3Math";
    t3MathData: "t3MathData";
  }
}

// Bound both incomplete-delimiter lookahead and work handed to a TeX renderer.
const MAX_MATH_LENGTH = 16_384;

export function markdownMath(source: string): MarkdownMath | null {
  const opener = source.startsWith("$$") ? "$$" : source.slice(0, 2);
  const delimiter = opener === "\\(" || opener === "\\[" || opener === "$$" ? opener : "$";
  const close = delimiter === "\\(" ? "\\)" : delimiter === "\\[" ? "\\]" : delimiter;
  if (
    !source.startsWith(delimiter) ||
    !source.endsWith(close) ||
    source.length <= delimiter.length + close.length ||
    source.length > MAX_MATH_LENGTH
  )
    return null;
  const tex = source.slice(delimiter.length, -close.length).trim();
  return tex ? { source, tex, display: delimiter === "$$" || delimiter === "\\[" } : null;
}

const tokenizeMath: Tokenizer = function (effects, ok, nok) {
  let opener: "$" | "$$" | "\\(" | "\\[" = "$";
  let count = 0;
  let previous: Code = null;
  let closingCount = 0;
  let hasContent = false;
  let lineStart = false;
  let dataOpen = false;
  const closeData = () => {
    if (dataOpen) effects.exit("t3MathData");
    dataOpen = false;
  };
  const consume = (code: Code) => {
    if (!dataOpen) effects.enter("t3MathData");
    dataOpen = true;
    effects.consume(code);
    count += 1;
    previous = code;
  };
  return start;

  function unfinished(code: Code): State | undefined {
    if (opener === "$" || opener === "$$") return nok(code);
    closeData();
    effects.exit("t3Math");
    return ok(code);
  }
  function start(code: Code): State | undefined {
    effects.enter("t3Math");
    consume(code);
    return code === 92 ? backslashOpen : dollarOpen;
  }
  function backslashOpen(code: Code): State | undefined {
    if (code !== 40 && code !== 91) return nok(code);
    opener = code === 40 ? "\\(" : "\\[";
    consume(code);
    return body;
  }
  function dollarOpen(code: Code): State | undefined {
    if (code === 36) {
      opener = "$$";
      consume(code);
      return displayStart;
    }
    if (code === null || markdownLineEnding(code) || markdownSpace(code)) return nok(code);
    return body(code);
  }
  function displayStart(code: Code): State | undefined {
    return code === 36 ? nok(code) : body(code);
  }
  function body(code: Code): State | undefined {
    if (code === null || count >= MAX_MATH_LENGTH) return unfinished(code);
    if (markdownLineEnding(code)) {
      // A blank line ends a candidate. Never swallow later paragraphs while streaming.
      if (lineStart || opener === "$") return unfinished(code);
      lineStart = true;
      closeData();
      effects.enter("lineEnding");
      effects.consume(code);
      effects.exit("lineEnding");
      count += 1;
      previous = code;
      return body;
    }
    if (!markdownSpace(code)) lineStart = false;
    if (code === 92) {
      consume(code);
      return escaped;
    }
    if (code === 36 && (opener === "$" || opener === "$$")) {
      if (
        !hasContent ||
        (opener === "$" && (markdownSpace(previous) || markdownLineEnding(previous)))
      )
        return nok(code);
      closingCount = 1;
      consume(code);
      return closeDollar;
    }
    if (!markdownSpace(code)) hasContent = true;
    consume(code);
    return body;
  }
  function escaped(code: Code): State | undefined {
    if ((opener === "\\(" && code === 41) || (opener === "\\[" && code === 93)) {
      consume(code);
      closeData();
      effects.exit("t3Math");
      return ok;
    }
    if (code === null || markdownLineEnding(code)) return body(code);
    hasContent = true;
    consume(code);
    return body;
  }
  function closeDollar(code: Code): State | undefined {
    if (code === 36) {
      closingCount += 1;
      consume(code);
      return closeDollar;
    }
    if (closingCount !== opener.length) return nok(code);
    // Pandoc-style dollar boundaries keep "$20 and $30" as ordinary prose.
    if (opener === "$" && code !== null && code >= 48 && code <= 57) return nok(code);
    closeData();
    effects.exit("t3Math");
    return ok(code);
  }
};

/** Recognize math in Markdown's text grammar, so code, links and escapes keep their semantics. */
function attachMath(this: Processor) {
  const data = this.data();
  const construct: Construct = { tokenize: tokenizeMath };
  (data.micromarkExtensions ??= []).push({
    text: { 36: construct, 92: construct },
  });
  (data.fromMarkdownExtensions ??= []).push({
    enter: {
      t3Math(token) {
        const source = this.sliceSerialize(token);
        const math = markdownMath(source);
        this.enter(
          {
            type: "inlineMath",
            value: math?.tex ?? source,
            data: {
              math,
              hName: "span",
              hProperties: { dataMathSource: source },
            },
          },
          token,
        );
      },
    },
    exit: {
      t3Math(token) {
        this.exit(token);
      },
    },
  });
}

export const remarkMath = attachMath;

const parser = unified().use(remarkParse).use(remarkMath).freeze();

/** Source ranges let native Markdown use the same grammar without a second delimiter scanner. */
export function markdownMathRanges(source: string) {
  const matches: Array<{ source: string; math: MarkdownMath | null; start: number; end: number }> =
    [];
  if (!source.includes("$") && !source.includes("\\(") && !source.includes("\\[")) return matches;
  const tree = parser.parse(source);
  function visit(node: Root | Root["children"][number] | MathNode): void {
    if (node.type === "inlineMath") {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start !== undefined && end !== undefined)
        matches.push({
          source: node.data.hProperties.dataMathSource,
          math: node.data.math,
          start,
          end,
        });
    } else if ("children" in node) {
      for (const child of node.children) visit(child);
    }
  }
  visit(tree);
  return matches;
}
