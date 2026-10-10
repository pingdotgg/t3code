import { mathFromMarkdown } from "mdast-util-math";
import { math } from "micromark-extension-math";
import { markdownLineEnding } from "micromark-util-character";
import type { Construct, Extension, Tokenizer } from "micromark-util-types";
import type { Processor } from "unified";

// Use the math extension's tokens so backslash delimiters keep the same AST and source
// positions as dollar math. Recognize them before CommonMark consumes escapes.
const tokenizeLatexMath: Tokenizer = (effects, ok, nok) => {
  let closing = 0;
  let dataOpen = false;
  const end: Construct = {
    partial: true,
    tokenize(effects, ok, nok) {
      return (code) => {
        effects.enter("mathTextSequence");
        effects.consume(code!);
        return (code) => {
          if (code !== closing) return nok(code);
          effects.consume(code);
          effects.exit("mathTextSequence");
          return ok;
        };
      };
    },
  };

  return (code) => {
    effects.enter("mathText");
    effects.enter("mathTextSequence");
    effects.consume(code!);
    return (code) => {
      if (code !== 40 && code !== 91) return nok(code);
      closing = code === 40 ? 41 : 93;
      effects.consume(code);
      effects.exit("mathTextSequence");
      return body;
    };
  };

  function body(code: number | null) {
    if (code === null) return nok(code);
    if (code === 92) return effects.check(end, close, escape)(code);
    if (markdownLineEnding(code)) {
      if (dataOpen) effects.exit("mathTextData");
      dataOpen = false;
      effects.enter("lineEnding");
      effects.consume(code);
      effects.exit("lineEnding");
      return body;
    }
    openData();
    effects.consume(code);
    return body;
  }

  function escape(code: number | null) {
    openData();
    effects.consume(code!);
    return (code: number | null) => {
      if (code === null || markdownLineEnding(code)) return body(code);
      effects.consume(code);
      return body;
    };
  }

  function close(code: number | null) {
    if (dataOpen) effects.exit("mathTextData");
    effects.enter("mathTextSequence");
    effects.consume(code!);
    return (code: number | null) => {
      effects.consume(code!);
      effects.exit("mathTextSequence");
      effects.exit("mathText");
      return ok;
    };
  }

  function openData() {
    if (!dataOpen) effects.enter("mathTextData");
    dataOpen = true;
  }
};

const LATEX_MATH_SYNTAX: Extension = { text: { 92: { tokenize: tokenizeLatexMath } } };

/** Parse dollar math and the LaTeX delimiters commonly emitted by providers. */
function remarkChatMath(this: Processor) {
  // oxlint-disable-next-line oxc/no-this-in-exported-function -- Unified binds plugins to their processor.
  const data = this.data();
  // Single dollars are skill mentions and prices in chat. Use \(...\) for
  // inline math and \[...\] or $$ fences for display math.
  const syntax = math({ singleDollarTextMath: false });
  const flow = syntax.flow![36] as Construct;
  syntax.flow = {
    36: {
      ...flow,
      tokenize(effects, ok, nok) {
        const start = this.events.length;
        return flow.tokenize.call(
          this,
          effects,
          (code) => {
            if (this.interrupt) return ok(code);
            let fences = 0;
            for (let index = start; index < this.events.length; index++) {
              const event = this.events[index]!;
              if (event[0] === "exit" && event[1].type === "mathFlowFence") fences++;
            }
            // Unlike code fences, unfinished math stays literal while streaming.
            return fences > 1 ? ok(code) : nok(code);
          },
          nok,
        );
      },
    },
  };
  (data.micromarkExtensions ??= []).push(syntax, LATEX_MATH_SYNTAX);
  const fromMarkdown = mathFromMarkdown();
  fromMarkdown.enter!.mathText = function (token) {
    this.enter(
      {
        type: "inlineMath",
        value: "",
        data: {
          hName: "code",
          hProperties: {
            className: [
              "language-math",
              this.sliceSerialize(token).startsWith("\\[") ? "math-display" : "math-inline",
            ],
          },
          hChildren: [],
        },
      },
      token,
    );
    this.buffer();
  };
  (data.fromMarkdownExtensions ??= []).push(fromMarkdown);
}

export { remarkChatMath };
