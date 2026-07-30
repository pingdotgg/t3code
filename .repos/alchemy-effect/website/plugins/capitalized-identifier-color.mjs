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

const eq = (a, b) => (a || "").toLowerCase() === b.toLowerCase();

export function capitalizedIdentifierColor() {
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
