import type { Root, RootContent } from "mdast";
// oxlint-disable-next-line unicorn/require-module-specifiers -- Load only the parser's token type augmentation.
import type {} from "micromark-extension-math";
import { markdownLineEnding, markdownSpace } from "micromark-util-character";
import type { Construct, State } from "micromark-util-types";
import remarkMath from "remark-math";
import type { Plugin } from "unified";

const BACKSLASH = 92;

/** Recognize TeX delimiters in the parser, so code, links, and HTML retain their
 * normal Markdown boundaries and source positions remain valid while streaming.
 */
function latexMath(flow: boolean): Construct {
  return {
    name: flow ? "latexMathFlow" : "latexMathText",
    ...(flow ? { concrete: true } : {}),
    /** Tokenize a TeX-delimited expression while preserving Markdown source positions. */
    tokenize(effects, ok, nok) {
      const math = flow ? "mathFlow" : "mathText";
      const fence = flow ? "mathFlowFence" : "mathTextSequence";
      const value = flow ? "mathFlowValue" : "mathTextData";
      let closing: number;
      let inValue = false;
      const closingDelimiter: Construct = {
        partial: true,
        /** Probe for the matching closing delimiter without consuming a failed match. */
        tokenize(checkEffects, yes, no) {
          return (code) => {
            checkEffects.enter("mathTextSequence");
            checkEffects.consume(code);
            return (next) => {
              if (next !== closing) return no(next);
              checkEffects.consume(next);
              checkEffects.exit("mathTextSequence");
              return yes;
            };
          };
        },
      };

      return start;

      /** Begin the math token at the opening backslash. */
      function start(code: number | null): State | undefined {
        effects.enter(math);
        effects.enter(fence);
        effects.consume(code);
        return opening;
      }

      /** Select the matching delimiter, allowing only brackets in flow mode. */
      function opening(code: number | null): State | undefined {
        if (code !== 91 && (flow || code !== 40)) return nok(code);
        closing = code === 91 ? 93 : 41;
        effects.consume(code);
        effects.exit(fence);
        return inside;
      }

      /** Consume formula content until a matching delimiter or an incomplete ending. */
      function inside(code: number | null): State | undefined {
        if (code === null) return nok(code);
        if (markdownLineEnding(code)) {
          if (inValue) effects.exit(value);
          inValue = false;
          effects.enter("lineEnding");
          effects.consume(code);
          effects.exit("lineEnding");
          return inside;
        }
        if (code === BACKSLASH) {
          return effects.check(closingDelimiter, close, escape)(code);
        }
        if (!inValue) effects.enter(value);
        inValue = true;
        effects.consume(code);
        return inside;
      }

      /** Keep escaped characters inside the formula instead of treating them as delimiters. */
      function escape(code: number | null): State | undefined {
        if (!inValue) effects.enter(value);
        inValue = true;
        effects.consume(code);
        return (next) => {
          if (next === null) return nok(next);
          if (markdownLineEnding(next)) return inside(next);
          effects.consume(next);
          return inside;
        };
      }

      /** Finish the formula and check trailing content when parsing a display block. */
      function close(code: number | null): State | undefined {
        if (inValue) effects.exit(value);
        effects.enter(fence);
        effects.consume(code);
        return (next) => {
          effects.consume(next);
          effects.exit(fence);
          effects.exit(math);
          return flow ? after : ok;
        };
      }

      /** Accept a display block only when the rest of its line is whitespace. */
      function after(code: number | null): State | undefined {
        // A display formula with surrounding prose belongs to the paragraph.
        if (code === null || markdownLineEnding(code)) return ok(code);
        if (markdownSpace(code)) {
          effects.enter("whitespace");
          return trailingSpace(code);
        }
        return nok(code);
      }

      /** Consume trailing display-block whitespace before checking the line ending. */
      function trailingSpace(code: number | null): State | undefined {
        if (markdownSpace(code)) {
          effects.consume(code);
          return trailingSpace;
        }
        effects.exit("whitespace");
        return after(code);
      }
    },
  };
}

/** Add dollar and TeX math, keeping the authored source for selection-and-copy. */
export const remarkChatMath: Plugin<[], Root> = function () {
  remarkMath.call(this);
  const data = this.data();
  const extensions = data.micromarkExtensions ?? (data.micromarkExtensions = []);
  const dollarSyntax = extensions.at(-1)?.text;
  const dollar = dollarSyntax?.[36];
  if (dollarSyntax && dollar && !Array.isArray(dollar)) {
    dollarSyntax[36] = {
      ...dollar,
      /** Reject spaced single-dollar expressions so prices do not swallow later math. */
      tokenize(effects, ok, nok) {
        return dollar.tokenize.call(
          this,
          effects,
          (code) => {
            const token = this.events.at(-1)?.[1];
            const source = token ? this.sliceSerialize(token) : "";
            // Single-dollar math hugs its content. Otherwise prices such as
            // "$5 and $10" can consume the opener of a later real equation.
            return !source.startsWith("$$") && /^\$\s|\s\$$/.test(source) ? nok(code) : ok(code);
          },
          nok,
        );
      },
    };
  }
  extensions.push({
    flow: { [BACKSLASH]: latexMath(true) },
    text: { [BACKSLASH]: latexMath(false) },
  });

  // Attach rendering metadata during parsing: list recovery parses synthetic
  // source later, and its offsets do not belong to the original message.
  const parse = this.parser;
  if (!parse) return;
  this.parser = (source, file) => {
    const tree = parse(source, file) as Root;
    /** Attach rendering and copy metadata, removing container prefixes from copied formulas. */
    const visit = (node: Root | RootContent, inContainer = false) => {
      if (node.type === "math" || node.type === "inlineMath") {
        const start = node.position?.start.offset;
        const end = node.position?.end.offset;
        const authored =
          start === undefined || end === undefined ? undefined : source.slice(start, end);
        const display =
          node.type === "math" || authored?.startsWith("\\[") || authored?.startsWith("$$");
        let copySource = authored ?? (display ? `$$\n${node.value}\n$$` : `$${node.value}$`);
        if (inContainer && /[\r\n]/.test(copySource)) {
          // Source offsets include quote/list prefixes on continuation lines.
          // The parsed value omits them, so copying just the formula stays valid.
          const opening = /^\\[[(]|^\$+/.exec(copySource)?.[0] ?? "$$";
          const closing = opening === "\\[" ? "\\]" : opening === "\\(" ? "\\)" : opening;
          const padding = node.type === "math" ? "\n" : "";
          const ending = copySource.endsWith(closing) ? `${padding}${closing}` : "";
          copySource = `${opening}${padding}${node.value}${ending}`;
        }
        // Use one code node for both modes; ChatMarkdown renders it without its
        // code-block toolbar. Only these classes opt into math, not code fences.
        node.data = {
          hName: "code",
          hProperties: {
            className: [display ? "math-display" : "math-inline"],
            dataMathSource: copySource,
          },
          hChildren: [{ type: "text", value: node.value }],
        };
      }
      if ("children" in node) {
        node.children.forEach((child) =>
          visit(child, inContainer || node.type === "blockquote" || node.type === "listItem"),
        );
      }
    };
    visit(tree);
    return tree;
  };
};
