import type { Root } from "mdast";
import type { CompileContext, Extension as FromMarkdownExtension } from "mdast-util-from-markdown";
import { mathFromMarkdown } from "mdast-util-math";
import type {
  Code,
  Construct,
  Effects,
  Extension as MicromarkExtension,
  State,
  Token,
  TokenizeContext,
} from "micromark-util-types";
import type { Plugin } from "unified";

declare module "micromark-util-types" {
  interface TokenTypeMap {
    mathFlow: "mathFlow";
    mathFlowFence: "mathFlowFence";
    mathFlowFenceSequence: "mathFlowFenceSequence";
    mathFlowValue: "mathFlowValue";
    mathText: "mathText";
    mathTextData: "mathTextData";
    mathTextSequence: "mathTextSequence";
  }
}

const DOLLAR = 36;
const BACKSLASH = 92;
const RIGHT_PAREN = 41;
const RIGHT_BRACKET = 93;
const COMMA = 44;
const CLOSERS: Partial<Record<number, number>> = { 40: RIGHT_PAREN, 91: RIGHT_BRACKET };
// ponytail: an opener gives up after this many characters, which keeps a message
// full of unmatched `$` close to linear. Raise it if real formulas hit the cap.
const MAX_MATH_LENGTH = 4096;

// micromark encodes tabs, virtual spaces, and line endings as negative codes.
const isLineEnding = (code: Code) => code !== null && code < -2;
const isWhitespace = (code: Code) => code !== null && (code < 0 || code === 32);
const isDigit = (code: Code) => code !== null && code >= 48 && code <= 57;

/**
 * Tokenizes `$…$`, `$$…$$`, `\(…\)`, and `\[…\]` inside paragraphs. Code spans,
 * links, autolinks, and escapes keep their CommonMark meaning because the
 * parser reaches them first, and source positions stay those of the message.
 * Single-dollar math follows Pandoc so prices stay prose: it hugs its content,
 * stays on one line, and its closing `$` is not followed by a digit.
 */
function mathText(delimiter: typeof DOLLAR | typeof BACKSLASH): Construct {
  return {
    name: delimiter === DOLLAR ? "chatDollarMath" : "chatBracketMath",
    // A `$` right after another one is part of that run, unless the first was escaped.
    ...(delimiter === DOLLAR
      ? {
          previous(this: TokenizeContext, code: Code) {
            return code !== DOLLAR || this.events.at(-1)?.[1].type === "characterEscape";
          },
        }
      : {}),
    tokenize(effects, ok, nok) {
      let size = 0;
      let closer = DOLLAR;
      let length = 0;
      let last: Code = null;
      // `\[1\]` is a citation, not an equation.
      let citation = true;
      const closing: Construct = { partial: true, tokenize: tokenizeClosing };

      return function start(code) {
        effects.enter("mathText");
        effects.enter("mathTextSequence");
        if (delimiter === DOLLAR) return dollarOpening(code);
        effects.consume(code);
        return bracketOpening;
      };

      function dollarOpening(code: Code): State | undefined {
        if (code === DOLLAR) {
          if (++size > 2) return nok(code);
          effects.consume(code);
          return dollarOpening;
        }
        if (size === 1 && (code === null || isWhitespace(code))) return nok(code);
        effects.exit("mathTextSequence");
        return between(code);
      }

      function bracketOpening(code: Code): State | undefined {
        const close = code === null ? undefined : CLOSERS[code];
        if (close === undefined) return nok(code);
        closer = close;
        effects.consume(code);
        effects.exit("mathTextSequence");
        return between;
      }

      function between(code: Code): State | undefined {
        if (code === null || length > MAX_MATH_LENGTH) return nok(code);
        if (isLineEnding(code)) {
          if (delimiter === DOLLAR && size === 1) return nok(code);
          effects.enter("lineEnding");
          effects.consume(code);
          effects.exit("lineEnding");
          last = code;
          return between;
        }
        if (code === delimiter) return effects.attempt(closing, after, data)(code);
        return data(code);
      }

      function data(code: Code): State | undefined {
        effects.enter("mathTextData");
        return dataCharacter(code);
      }

      /** Consumes one character unconditionally; a backslash takes the next one along. */
      function dataCharacter(code: Code): State | undefined {
        consume(code);
        return code === BACKSLASH ? escaped : inside;
      }

      function escaped(code: Code): State | undefined {
        if (code === null || isLineEnding(code)) return inside(code);
        consume(code);
        // An escaped `\$` neither closes nor extends a dollar run.
        last = null;
        return inside;
      }

      function inside(code: Code): State | undefined {
        const failedRun = code === DOLLAR && last === DOLLAR;
        if (
          code === null ||
          isLineEnding(code) ||
          length > MAX_MATH_LENGTH ||
          (code === delimiter && !failedRun)
        ) {
          effects.exit("mathTextData");
          return between(code);
        }
        return dataCharacter(code);
      }

      function consume(code: Code) {
        if (!isWhitespace(code) && !isDigit(code) && code !== COMMA) citation = false;
        effects.consume(code);
        last = code;
        length++;
      }

      function after(code: Code): State | undefined {
        if (closer === RIGHT_BRACKET && citation) return nok(code);
        effects.exit("mathText");
        return ok(code);
      }

      function tokenizeClosing(effects: Effects, ok: State, nok: State): State {
        let run = 0;
        return function start(code) {
          if (length === 0) return nok(code);
          if (delimiter === DOLLAR && size === 1 && isWhitespace(last)) return nok(code);
          effects.enter("mathTextSequence");
          effects.consume(code);
          if (delimiter === DOLLAR) {
            run = 1;
            return dollarRun;
          }
          return bracketClose;
        };

        function dollarRun(code: Code): State | undefined {
          if (code === DOLLAR) {
            run++;
            effects.consume(code);
            return dollarRun;
          }
          if (run !== size || (size === 1 && isDigit(code))) return nok(code);
          effects.exit("mathTextSequence");
          return ok(code);
        }

        function bracketClose(code: Code): State | undefined {
          if (code !== closer) return nok(code);
          effects.consume(code);
          effects.exit("mathTextSequence");
          return ok;
        }
      }
    },
  };
}

const FENCES: Partial<Record<number, { open: number[]; close: number[] }>> = {
  [DOLLAR]: { open: [DOLLAR, DOLLAR], close: [DOLLAR, DOLLAR] },
  [BACKSLASH]: { open: [BACKSLASH, 91], close: [BACKSLASH, RIGHT_BRACKET] },
};

/** Consumes `codes` exactly, then continues with `ok`. */
function sequence(effects: Effects, codes: number[], ok: State, nok: State): State {
  let index = 0;
  return function next(code) {
    if (index === codes.length) return ok(code);
    if (code !== codes[index]) return nok(code);
    effects.consume(code);
    index++;
    return next;
  };
}

/**
 * `$$` or `\[` alone on a line opens a display block that runs to the matching
 * `$$` or `\]` line, like a code fence, so formula lines that start with `-`,
 * `#`, or `1.` stay TeX instead of becoming lists or headings.
 */
const mathBlock: Construct = {
  name: "chatMathBlock",
  concrete: true,
  tokenize(effects, ok, nok) {
    const interrupt = this.interrupt;
    let fence = FENCES[DOLLAR]!;
    const nonLazyContinuation: Construct = { partial: true, tokenize: tokenizeNonLazy };
    const closing: Construct = { partial: true, tokenize: tokenizeClosing };

    return function start(code) {
      const selected = code === null ? undefined : FENCES[code];
      if (!selected) return nok(code);
      fence = selected;
      effects.enter("mathFlow");
      effects.enter("mathFlowFence");
      effects.enter("mathFlowFenceSequence");
      return sequence(effects, fence.open, afterOpening, nok)(code);
    };

    function afterOpening(code: Code): State | undefined {
      effects.exit("mathFlowFenceSequence");
      return openingRest(code);
    }

    function openingRest(code: Code): State | undefined {
      // Unlike a code fence, a block needs its closing line, so a formula
      // still streaming in stays text instead of typesetting each prefix.
      if (code === null) return nok(code);
      if (isLineEnding(code)) {
        effects.exit("mathFlowFence");
        if (interrupt) return ok(code);
        return effects.attempt(nonLazyContinuation, lineStart, after)(code);
      }
      if (!isWhitespace(code)) return nok(code);
      effects.consume(code);
      return openingRest;
    }

    function lineStart(code: Code): State | undefined {
      return effects.attempt(closing, after, content)(code);
    }

    function content(code: Code): State | undefined {
      if (code === null) return nok(code);
      if (isLineEnding(code)) return effects.attempt(nonLazyContinuation, lineStart, after)(code);
      effects.enter("mathFlowValue");
      return value(code);
    }

    function value(code: Code): State | undefined {
      if (code === null || isLineEnding(code)) {
        effects.exit("mathFlowValue");
        return content(code);
      }
      effects.consume(code);
      return value;
    }

    function after(code: Code): State | undefined {
      effects.exit("mathFlow");
      return ok(code);
    }

    function tokenizeClosing(effects: Effects, ok: State, nok: State): State {
      return function start(code) {
        effects.enter("mathFlowFence");
        return indent(code);
      };

      function indent(code: Code): State | undefined {
        if (isWhitespace(code) && !isLineEnding(code)) {
          effects.consume(code);
          return indent;
        }
        effects.enter("mathFlowFenceSequence");
        return sequence(effects, fence.close, afterSequence, nok)(code);
      }

      function afterSequence(code: Code): State | undefined {
        effects.exit("mathFlowFenceSequence");
        return rest(code);
      }

      function rest(code: Code): State | undefined {
        if (code === null || isLineEnding(code)) {
          effects.exit("mathFlowFence");
          return ok(code);
        }
        if (!isWhitespace(code)) return nok(code);
        effects.consume(code);
        return rest;
      }
    }

    /** Ends the block at a lazy line, such as one that leaves a blockquote. */
    function tokenizeNonLazy(this: TokenizeContext, effects: Effects, ok: State, nok: State) {
      const isLazy = () => this.parser.lazy[this.now().line];
      return function start(code: Code): State | undefined {
        if (code === null) return ok(code);
        effects.enter("lineEnding");
        effects.consume(code);
        effects.exit("lineEnding");
        return (next: Code) => (isLazy() ? nok(next) : ok(next));
      };
    }
  },
};

export const chatMathSyntax: MicromarkExtension = {
  flow: { [DOLLAR]: mathBlock, [BACKSLASH]: mathBlock },
  text: { [DOLLAR]: mathText(DOLLAR), [BACKSLASH]: mathText(BACKSLASH) },
};

const MATH_DISPLAY = ["language-math", "math-display"];
const baseFromMarkdown = mathFromMarkdown();

export const chatMathFromMarkdown: FromMarkdownExtension = {
  ...baseFromMarkdown,
  exit: {
    ...baseFromMarkdown.exit,
    /** Blocks render through the same `code` element as inline math, not a code fence. */
    mathFlow(this: CompileContext, token: Token) {
      baseFromMarkdown.exit?.mathFlow?.call(this, token);
      const parent = this.stack.at(-1);
      const node = parent && "children" in parent ? parent.children.at(-1) : undefined;
      if (node?.type !== "math") return;
      node.data = {
        hName: "code",
        hProperties: { className: MATH_DISPLAY },
        hChildren: [{ type: "text", value: node.value }],
      };
    },
    /** `$$…$$` and `\[…\]` display even when they share a line with prose. */
    mathTextSequence(this: CompileContext, token: Token) {
      const sequence = this.sliceSerialize(token);
      if (sequence !== "$$" && sequence !== "\\[") return;
      const node = this.stack.at(-2);
      if (node?.type === "inlineMath" && node.data?.hProperties) {
        node.data.hProperties.className = MATH_DISPLAY;
      }
    },
  },
};

/** Parses TeX math in chat markdown. Rendered by `MarkdownMath` from `code.math-*` elements. */
export const remarkChatMath: Plugin<[], Root> = function () {
  const data = this.data();
  (data.micromarkExtensions ??= []).push(chatMathSyntax);
  (data.fromMarkdownExtensions ??= []).push(chatMathFromMarkdown);
};

/** Messages without these characters skip math parsing entirely. */
export function mayContainMath(text: string): boolean {
  return text.includes("$") || text.includes("\\(") || text.includes("\\[");
}

export function mathKind(className: string | undefined): "inline" | "display" | null {
  if (!className?.includes("language-math")) return null;
  if (className.includes("math-display")) return "display";
  return className.includes("math-inline") ? "inline" : null;
}
