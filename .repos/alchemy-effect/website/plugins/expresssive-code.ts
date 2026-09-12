import {
  ExpressiveCodeTheme,
  type AnnotationRenderOptions,
  type ExpressiveCodePlugin,
} from "@astrojs/starlight/expressive-code";

/**
 * Alchemy "walnut sunrise" Expressive Code theme.
 *
 * Dark walnut bg (#2a2620) + sunrise syntax tokens that match the design
 * system's `--alc-code-*` variables. Designed for legibility on cream
 * parchment pages where every other surface is light.
 */
export const alchemyWalnutTheme = new ExpressiveCodeTheme({
  name: "alchemy-walnut-sunrise",
  type: "dark",
  semanticHighlighting: true,
  colors: {
    "editor.background": "#2a2620",
    "editor.foreground": "#faf5e3",
    "editor.lineHighlightBackground": "#36302280",
    "editor.selectionBackground": "#5c7a3e66",
    "editorLineNumber.foreground": "#85714f",
    "editorLineNumber.activeForeground": "#faf5e3",
    "editorIndentGuide.background": "#4e402c",
    "editorIndentGuide.activeBackground": "#68573c",
    "editorBracketMatch.background": "#5c7a3e33",
    "editorBracketMatch.border": "#5c7a3e",
    "editorWidget.background": "#363022",
    "editorWidget.border": "#4e402c",
    "editorHoverWidget.background": "#363022",
    "editorHoverWidget.border": "#4e402c",
    "editorGroupHeader.tabsBackground": "#1a1813",
    "tab.activeBackground": "#2a2620",
    "tab.inactiveBackground": "#1a1813",
    "tab.activeForeground": "#faf5e3",
    "tab.inactiveForeground": "#a89572",
    "tab.border": "#4e402c",
    focusBorder: "#5c7a3e",
    "scrollbarSlider.background": "#4e402c80",
    "scrollbarSlider.hoverBackground": "#68573c80",
    "scrollbarSlider.activeBackground": "#85714f80",
    "diffEditor.insertedTextBackground": "#5c7a3e26",
    "diffEditor.removedTextBackground": "#b3462e26",
  },
  tokenColors: [
    {
      scope: ["comment", "punctuation.definition.comment", "string.comment"],
      settings: { foreground: "#b3a27a", fontStyle: "italic" },
    },
    {
      scope: [
        "keyword",
        "storage",
        "storage.type",
        "storage.modifier",
        "keyword.control",
        "keyword.operator.new",
        "keyword.operator.expression",
        "keyword.other",
      ],
      settings: { foreground: "#d4f26a" },
    },
    {
      scope: [
        "keyword.operator",
        "punctuation.separator",
        "punctuation.terminator",
      ],
      settings: { foreground: "#c7b795" },
    },
    {
      scope: ["string", "string.quoted", "punctuation.definition.string"],
      settings: { foreground: "#ffe38a" },
    },
    {
      scope: ["string.template", "punctuation.definition.template-expression"],
      settings: { foreground: "#ffe38a" },
    },
    {
      scope: ["constant.numeric", "constant.language", "constant.character"],
      settings: { foreground: "#ff9a6b" },
    },
    {
      scope: [
        "constant.language.boolean",
        "constant.language.null",
        "constant.language.undefined",
      ],
      settings: { foreground: "#ff9a6b" },
    },
    {
      scope: [
        "entity.name.function",
        "support.function",
        "meta.function-call entity.name.function",
        "meta.function-call.method entity.name.function",
        "variable.function",
        "meta.definition.method entity.name.function",
      ],
      settings: { foreground: "#7ddfff" },
    },
    {
      scope: [
        "entity.name.type",
        "entity.name.class",
        "entity.name.interface",
        "entity.name.namespace",
        "support.type",
        "support.class",
        "support.other.namespace",
        "support.module",
        "meta.type",
      ],
      settings: { foreground: "#7ddfff" },
    },
    {
      scope: [
        "variable.other.object",
        "variable.other.readwrite.alias",
        "meta.import variable.other.readwrite",
        "meta.export variable.other.readwrite",
        "meta.object-literal.key support.type.object",
      ],
      settings: { foreground: "#7ddfff" },
    },
    {
      scope: ["entity.name.tag", "meta.tag entity.name.tag"],
      settings: { foreground: "#ffb968" },
    },
    {
      scope: ["entity.other.attribute-name"],
      settings: { foreground: "#d4f26a", fontStyle: "italic" },
    },
    {
      scope: [
        "variable",
        "variable.other",
        "variable.parameter",
        "meta.definition.variable variable.other",
      ],
      settings: { foreground: "#faf5e3" },
    },
    {
      scope: ["variable.other.constant"],
      settings: { foreground: "#7ddfff" },
    },
    {
      scope: ["variable.other.enummember"],
      settings: { foreground: "#ff9a6b" },
    },
    {
      scope: ["variable.other.property", "meta.object.member"],
      settings: { foreground: "#faf5e3" },
    },
    {
      scope: ["support.variable", "support.constant"],
      settings: { foreground: "#7ddfff" },
    },
    {
      scope: ["punctuation.section.embedded", "meta.embedded"],
      settings: { foreground: "#faf5e3" },
    },
    {
      scope: ["markup.heading", "markup.bold"],
      settings: { foreground: "#faf5e3", fontStyle: "bold" },
    },
    {
      scope: ["markup.italic"],
      settings: { foreground: "#faf5e3", fontStyle: "italic" },
    },
    {
      scope: ["markup.inserted", "markup.inserted.diff"],
      settings: { foreground: "#8fb15e" },
    },
    {
      scope: ["markup.deleted", "markup.deleted.diff"],
      settings: { foreground: "#e07a5f" },
    },
    {
      scope: ["invalid", "invalid.illegal"],
      settings: { foreground: "#e07a5f" },
    },
  ],
});

import { InlineStyleAnnotation } from "@astrojs/starlight/expressive-code";

const TARGET_LANGS = new Set([
  "ts",
  "tsx",
  "typescript",
  "js",
  "jsx",
  "javascript",
  "mts",
  "cts",
]);

const CAP_IDENT_RE = /\b[A-Z][A-Za-z0-9_]*\b/g;

const CYAN = "#7ddfff";
const STRING_COLOR = "#ffe38a";
const COMMENT_COLOR = "#b3a27a";

const eq = (a: string, b: string) =>
  (a || "").toLowerCase() === b.toLowerCase();

/**
 * Expressive Code plugin that paints every bare capitalized identifier
 * in TS/JS code blocks with the "type cyan" used by the marketing
 * highlighter (`src/components/marketing/highlightTS.ts`).
 *
 * Why: the TextMate TS grammar shipped with shiki does NOT tokenize
 * namespace references in expression position — `Alchemy` and `Effect`
 * inside `Alchemy.Stack(...)` and `Effect.gen(...)` come out as plain
 * untokenized text and fall back to the editor foreground. The
 * marketing landing page colors every capitalized identifier cyan,
 * giving snippets a distinct "type-y" rhythm. This plugin re-applies
 * that same rule to docs code blocks so syntax matches across the
 * whole site.
 *
 * The plugin runs AFTER syntax highlighting (which adds its own
 * `InlineStyleAnnotation`s with the walnut-sunrise colors), and skips
 * matches that overlap an existing string or comment annotation so
 * we don't recolor things like `"MyApp"` inside a string literal.
 */
export function capitalizedIdentifierColor(): ExpressiveCodePlugin {
  return {
    name: "capitalized-identifier-color",
    hooks: {
      postprocessAnalyzedCode({ codeBlock }) {
        if (!TARGET_LANGS.has(codeBlock.language)) return;

        for (const line of codeBlock.getLines()) {
          // Snapshot column ranges that already belong to strings or
          // comments — we don't want to recolor characters inside them
          // (e.g. the `MyApp` in `Alchemy.Stack("MyApp", ...)`).
          const skipRanges = [];
          for (const ann of line.getAnnotations()) {
            if (!ann.inlineRange) continue;
            // @ts-expect-error verify
            const c = ann.color;
            if (eq(c, STRING_COLOR) || eq(c, COMMENT_COLOR)) {
              skipRanges.push(ann.inlineRange);
            }
          }

          const text = line.text;
          CAP_IDENT_RE.lastIndex = 0;
          let m;
          while ((m = CAP_IDENT_RE.exec(text)) !== null) {
            const columnStart = m.index;
            const columnEnd = columnStart + m[0].length;
            const overlapsSkip = skipRanges.some(
              (r) => columnStart < r.columnEnd && columnEnd > r.columnStart,
            );
            if (overlapsSkip) continue;

            line.addAnnotation(
              new InlineStyleAnnotation({
                color: CYAN,
                inlineRange: { columnStart, columnEnd },
                // `normal` phase: runs after syntax highlighting
                // (`earliest`), so the cyan wraps and overrides any
                // walnut-sunrise color the tokenizer applied.
                renderPhase: "normal",
              }),
            );
          }
        }
      },
    },
  };
}

import { ExpressiveCodeAnnotation } from "@astrojs/starlight/expressive-code";
import { getClassNames, h } from "@astrojs/starlight/expressive-code/hast";

/** Matches `// @error: <text>`, tolerating a leading diff marker. */
const ERROR_COMMENT = /^(?:[+-](?=[\s/]))?\s*\/\/ @error: ?(.*)$/;

/** Extracts an optional `ts(NNNN)` code from the start of the message. */
const TS_CODE = /^ts\((\d+)\):?\s*/;

/** The line's token container (`.code` child), or the node itself. */
function codeContainer(node: any) {
  return (
    node.children?.find(
      (c: any) => c.type === "element" && getClassNames(c).includes("code"),
    ) ?? node
  );
}

class ErrorUnderlineAnnotation extends ExpressiveCodeAnnotation {
  render({ nodesToTransform }: AnnotationRenderOptions) {
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
  title?: string;
  message: string;

  constructor(title: string | undefined, message: string) {
    super({ renderPhase: "latest" });
    this.title = title;
    this.message = message;
  }
  render({ nodesToTransform }: AnnotationRenderOptions) {
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
export function errorAnnotations(): ExpressiveCodePlugin {
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
