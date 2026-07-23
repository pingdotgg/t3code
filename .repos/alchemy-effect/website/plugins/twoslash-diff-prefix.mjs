/**
 * Expressive Code plugin pair that adds `+` / `-` line-prefix support to
 * twoslash code blocks, similar to ```diff lang="typescript" but with
 * twoslash type-checking.
 *
 * Usage:
 *   ```typescript twoslash
 *   // @errors: 2345
 *   import { Bucket } from "./bucket.ts";
 * + const bucket = yield* Cloudflare.R2Bucket.bind(Bucket);
 *   ```
 *
 * How it works:
 *   1. `twoslashDiffPrefixStrip` runs BEFORE `ecTwoSlash` and rewrites
 *      each `+ foo` / `- foo` line into `  foo ...` with a trailing tag
 *      comment (`/_ __ALCHEMY_DIFF_INS__ _/` or `..._DEL__...`). This
 *      gives the TypeScript compiler valid source while preserving a
 *      marker that survives twoslash's rendered output.
 *   2. `twoslashDiffPrefixAnnotate` runs AFTER `ecTwoSlash` has replaced
 *      each block line with its rendered twoslash output. It scans the
 *      rendered lines for the tag comment, strips it, and attaches a
 *      full-line `highlight ins` / `highlight del` class annotation
 *      using the same CSS that `@expressive-code/plugin-text-markers`
 *      ships.
 */
import { ExpressiveCodeAnnotation } from "@astrojs/starlight/expressive-code";
import { addClassName } from "@astrojs/starlight/expressive-code/hast";

const INS_TAG = "/* __ALCHEMY_DIFF_INS__ */";
const DEL_TAG = "/* __ALCHEMY_DIFF_DEL__ */";

const isTwoslash = (codeBlock) => /\btwoslash\b/.test(codeBlock.meta);

class DiffMarkerAnnotation extends ExpressiveCodeAnnotation {
  constructor(markerType) {
    super({});
    this.markerType = markerType;
  }
  render({ nodesToTransform }) {
    return nodesToTransform.map((node) => {
      if (node.type === "element") {
        addClassName(node, "highlight");
        addClassName(node, this.markerType);
      }
      return node;
    });
  }
}

/** Register BEFORE `ecTwoSlash(...)` in the Expressive Code plugins array. */
export function twoslashDiffPrefixStrip() {
  return {
    name: "twoslash-diff-prefix-strip",
    hooks: {
      preprocessCode({ codeBlock }) {
        if (!isTwoslash(codeBlock)) return;
        for (const line of codeBlock.getLines()) {
          // Match a `+` or `-` at column 0 (but not `++`/`--`/`+-`/`-+`).
          // If followed by a space (or end of line), replace the marker with
          // a single space so column alignment of the rest of the line is
          // preserved exactly as authored. If followed by a non-space
          // character (e.g. `+import ...`), drop the marker entirely so
          // top-level statements stay flush-left.
          const match = line.text.match(/^([+-])(?![+-])(.*)$/);
          if (!match) continue;
          const [, marker, rest] = match;
          const tag = marker === "+" ? INS_TAG : DEL_TAG;
          const replacement =
            rest.length === 0 || rest.startsWith(" ") ? ` ${rest}` : rest;
          line.editText(0, line.text.length, `${replacement} ${tag}`);
        }
      },
    },
  };
}

/** Register AFTER `ecTwoSlash(...)` in the Expressive Code plugins array. */
export function twoslashDiffPrefixAnnotate() {
  return {
    name: "twoslash-diff-prefix-annotate",
    hooks: {
      preprocessCode({ codeBlock }) {
        if (!isTwoslash(codeBlock)) return;
        for (const line of codeBlock.getLines()) {
          const text = line.text;
          let markerType;
          let tagLength;
          if (text.endsWith(` ${INS_TAG}`)) {
            markerType = "ins";
            tagLength = INS_TAG.length + 1; // +1 for leading space
          } else if (text.endsWith(` ${DEL_TAG}`)) {
            markerType = "del";
            tagLength = DEL_TAG.length + 1;
          } else {
            continue;
          }
          line.editText(text.length - tagLength, text.length, "");
          line.addAnnotation(new DiffMarkerAnnotation(markerType));
        }
      },
    },
  };
}
