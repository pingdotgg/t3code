import { defineRule } from "@oxlint/plugins";

import {
  baseClass,
  ceilingMismatch,
  classTokens,
  maxOccurrencesSchema,
  readMaxOccurrences,
  suppressedLines,
} from "../classes.ts";

const SIDE = "(?:-(?:t|b|l|r|x|y|s|e|tl|tr|bl|br|ss|se|es|ee))?";
const OPACITY = String.raw`(?:\/[\w.[\]()-]+)?`;

// Each kind of hand-built surface ingredient and the design-system replacement for it.
// Radius tokens (rounded-card …), rounded-full/none, var()-based arbitrary values,
// border-transparent and border-divider hairlines fall through every pattern.
const KINDS = [
  {
    pattern: new RegExp(
      `^bg-(?:card|popover|background|muted|accent|secondary|sidebar|input)${OPACITY}$`,
      "u",
    ),
    hint: "A block is surface-card (a part inside a panel: surface-card-fill), a panel surface-panel, an inset field surface-well, an overlay surface-popover or surface-floating.",
  },
  {
    pattern: /^bg-(?:warning|destructive|error|info|success|foreground|primary)\/[\w.[\]()-]+$/u,
    hint: "A tint is surface-tint, Alert, surface-selected-soft or hover:surface-ghost-hover.",
  },
  {
    pattern: new RegExp(`^border${SIDE}-(?:border|input)${OPACITY}$`, "u"),
    hint: "A surface draws its own edge; a hairline is border-t or border-b with border-divider.",
  },
  {
    pattern: new RegExp(
      `^rounded${SIDE}(?:-(?:xs|sm|md|lg|xl|2xl|3xl|4xl)|-\\[(?!inherit\\])(?![^\\]]*var\\()[^\\]]+\\])?$`,
      "u",
    ),
    hint: "Radius is a token: rounded-card, rounded-row, rounded-item, rounded-control, rounded-badge, rounded-kbd or rounded-pane (or rounded-full).",
  },
  {
    pattern: new RegExp(
      `^shadow(?:-(?:2xs|xs|sm|md|lg|xl|2xl)|-\\[(?!var\\(--[\\w-]+\\)\\])[^\\]]+\\])?${OPACITY}$`,
      "u",
    ),
    hint: "Shadow comes from the surface (surface-raised, surface-floating, surface-dialog) or shadow-dialog and shadow-composer.",
  },
];

export function rawSurfaceClasses(value: string): ReadonlyArray<string> {
  return classTokens(value).filter((token) => {
    const base = baseClass(token);
    return KINDS.some((kind) => kind.pattern.test(base));
  });
}

const message = (found: ReadonlyArray<string>) => {
  const hints = KINDS.filter((kind) =>
    found.some((token) => kind.pattern.test(baseClass(token))),
  ).map((kind) => kind.hint);
  return `Hand-built surface (${found.slice(0, 4).join(" ")}). ${hints.join(" ")} See docs/internals/web-ui.md#surfaces.`;
};

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow hand-built backgrounds, borders, radii and shadows; use the surface-* utilities and radius tokens.",
    },
    schema: maxOccurrencesSchema,
    defaultOptions: [{ maxOccurrences: 0 }],
  },
  create(context) {
    const allowedCount = readMaxOccurrences(context.options);
    let occurrenceCount = 0;

    // Every string, like no-raw-type-classes: surfaces also hide in class constants, tone
    // maps, cva variants and cn() arguments, which a className walker would miss.
    let suppressed: ReadonlySet<number> | undefined;
    const exceedsCeiling = (value: string, line: number): ReadonlyArray<string> | null => {
      const found = rawSurfaceClasses(value);
      if (found.length === 0) return null;
      suppressed ??= suppressedLines(context.sourceCode, "t3code/no-raw-surface");
      if (suppressed.has(line)) return found;
      occurrenceCount++;
      return occurrenceCount > allowedCount ? found : null;
    };

    return {
      Literal(node) {
        if (typeof node.value !== "string") return;
        const found = exceedsCeiling(node.value, node.loc.start.line);
        if (found) context.report({ node, message: message(found) });
      },
      TemplateElement(node) {
        const found = exceedsCeiling(node.value.cooked ?? "", node.loc.start.line);
        if (found) context.report({ node, message: message(found) });
      },
      "Program:exit"() {
        const mismatch = ceilingMismatch(allowedCount, occurrenceCount);
        if (mismatch) context.report(mismatch);
      },
    };
  },
});
