/**
 * Compiler-free type-error annotations for code blocks.
 *
 * Replaces expressive-code-twoslash's error rendering (the part of twoslash
 * we actually rely on) without spinning up a TypeScript program per block.
 * Docs author errors as plain comments inside any fenced code block, so the
 * MDX source stays readable as code — agents ingesting the raw markdown see
 * a normal comment stating that (and why) the code fails to compile:
 *
 *   ```typescript
 *   const providers: Layer<Providers> = Layer.empty;
 *   // @error: ts(2322) Type 'Layer<never, never, never>' is not assignable
 *   // @error: to type 'Layer<NoInfer<Providers>, never, StackServices>'.
 *   ```
 *
 * Rules:
 * - A `// @error:` comment group annotates the nearest preceding code line:
 *   that line gets a red squiggle and the error box renders directly below
 *   it (exactly where the comment sits in the source).
 * - Consecutive `// @error:` lines merge into one message. Line breaks
 *   collapse when the box renders (white-space: normal), so wrapping long
 *   messages across several comment lines is purely cosmetic in the source.
 * - A leading `ts(NNNN)` on the first line becomes the box title
 *   ("Error ts(NNNN)  ― "), matching the twoslash UI.
 * - Works inside ```diff lang="typescript" blocks: a leading `+`/`-`/space
 *   diff marker before the comment is tolerated (the comment itself should
 *   be an unchanged/context line).
 *
 * The rendered markup and CSS replicate expressive-code-twoslash's error UI
 * (`.twoslash-error-underline` squiggle + `.twoslash-error-box`), so the
 * visual output is identical to what the compiler-backed plugin produced.
 */
import { ExpressiveCodeAnnotation } from "@astrojs/starlight/expressive-code";
import { getClassNames, h } from "@astrojs/starlight/expressive-code/hast";

/** Matches `// @error: <text>`, tolerating a leading diff marker. */
const ERROR_COMMENT = /^(?:[+-](?=[\s/]))?\s*\/\/ @error: ?(.*)$/;

/** Extracts an optional `ts(NNNN)` code from the start of the message. */
const TS_CODE = /^ts\((\d+)\):?\s*/;

/** The line's token container (`.code` child), or the node itself. */
function codeContainer(node) {
  return (
    node.children?.find(
      (c) => c.type === "element" && getClassNames(c).includes("code"),
    ) ?? node
  );
}

class ErrorUnderlineAnnotation extends ExpressiveCodeAnnotation {
  render({ nodesToTransform }) {
    return nodesToTransform.map((node) => {
      if (node.type !== "element") return node;
      // Wrap the line's tokens in a squiggle span rather than classing the
      // container: the error box is appended to the same container below,
      // and `text-decoration` propagates to descendants (it can't be
      // cancelled from inside), so the box must be a sibling of the
      // underlined span, not its child.
      const code = codeContainer(node);
      code.children = [
        h("span.twoslash.twoslash-error-underline", code.children ?? []),
      ];
      return node;
    });
  }
}

class ErrorBoxAnnotation extends ExpressiveCodeAnnotation {
  constructor(title, message) {
    super({ renderPhase: "latest" });
    this.title = title;
    this.message = message;
  }
  render({ nodesToTransform }) {
    return nodesToTransform.map((node) => {
      if (node.type !== "element") return node;
      // Append inside `.code` (a block container): a block-level flex box
      // after inline token content renders on its own line below the code,
      // exactly like twoslash's markup did. Appending to the `.ec-line`
      // instead puts the box on the same flex row as the code.
      codeContainer(node).children.push(
        h("div.twoslash-error-box.twoslash-error-level-error", [
          h("span.twoslash-error-box-icon"),
          h("span.twoslash-error-box-content", [
            ...(this.title
              ? [h("span.twoslash-error-box-content-title", this.title)]
              : []),
            h("span.twoslash-error-box-content-message", this.message),
          ]),
        ]),
      );
      return node;
    });
  }
}

export function errorAnnotations() {
  return {
    name: "error-annotations",
    baseStyles: `
      .twoslash-error-underline {
        text-decoration-line: spelling-error;
        position: relative;
      }
      .twoslash-error-box {
        display: flex;
        z-index: 10;
        padding: 0.1rem 0.3rem;
        font-style: italic;
        border: 1px solid rgba(from var(--al-error-col, #cd3131) r g b / 0.25);
        border-radius: 4px;
        font-size: 90%;
        white-space: normal;
        word-break: normal;
        overflow-wrap: normal;
        flex: 0 1 100%;
        color: var(--al-error-col, #cd3131);
        background: rgba(from var(--al-error-col, #cd3131) r g b / 0.1);
      }
      .twoslash-error-box .twoslash-error-box-icon {
        display: inline-block;
        vertical-align: middle;
      }
      .twoslash-error-box .twoslash-error-box-content {
        display: inline-block;
        vertical-align: middle;
        flex: 0 1 100%;
      }
      .twoslash-error-box-content-message {
        white-space: normal;
      }
    `,
    hooks: {
      preprocessCode({ codeBlock }) {
        const lines = codeBlock.getLines();
        /** @type {{ target: number, deletions: number[], parts: string[] }[]} */
        const groups = [];
        let current;
        for (let i = 0; i < lines.length; i++) {
          const match = lines[i].text.match(ERROR_COMMENT);
          if (!match) {
            current = undefined;
            continue;
          }
          if (current) {
            current.deletions.push(i);
            current.parts.push(match[1]);
          } else if (i > 0) {
            current = { target: i - 1, deletions: [i], parts: [match[1]] };
            groups.push(current);
          }
        }
        if (groups.length === 0) return;

        // Delete the comment lines (bottom-up so indices stay valid), then
        // annotate each group's target line. Targets never move: a group's
        // target always precedes its own deletions, and later groups'
        // deletions never precede an earlier group's target.
        const deleted = groups.flatMap((g) => g.deletions);
        codeBlock.deleteLines(deleted);
        for (const group of groups) {
          const shift = deleted.filter((d) => d < group.target).length;
          const line = codeBlock.getLine(group.target - shift);
          if (!line) continue;
          let message = group.parts.join("\n");
          let title;
          const code = message.match(TS_CODE);
          if (code) {
            title = `Error ts(${code[1]})  ― `;
            message = message.slice(code[0].length);
          }
          line.addAnnotation(new ErrorUnderlineAnnotation({}));
          line.addAnnotation(new ErrorBoxAnnotation(title, message));
        }
      },
    },
  };
}
