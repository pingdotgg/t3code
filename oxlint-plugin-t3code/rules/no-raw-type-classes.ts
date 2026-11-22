import { defineRule } from "@oxlint/plugins";

import {
  baseClass,
  ceilingMismatch,
  classTokens,
  maxOccurrencesSchema,
  readMaxOccurrences,
  suppressedLines,
} from "../classes.ts";

// Tailwind's size scale, the old 2xs/3xs steps and arbitrary sizes such as
// text-[13px]. A role (text-label, text-meta …) carries its own size and weight.
const RAW_SIZE =
  /^text-(?:xs|sm|base|lg|xl|[2-9]xl|2xs|3xs|\[(?:length:)?\d[\d.]*(?:px|rem|em)\])(?:\/[\w.[\]()-]+)?$/u;
const RAW_WEIGHT = /^font-(?:thin|extralight|light|normal|medium|semibold|bold|extrabold|black)$/u;

export function rawTypeClasses(value: string): ReadonlyArray<string> {
  return classTokens(value).filter((token) => {
    const base = baseClass(token);
    return RAW_SIZE.test(base) || RAW_WEIGHT.test(base);
  });
}

const MESSAGE =
  "Raw type classes ({{classes}}). Render <Text variant> from components/ui/text, or use a text-{role} class (title, prompt, label, body, meta, caption, micro) so type follows the design system's seven roles.";

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow Tailwind font-size and font-weight classes outside components/ui; use the type roles.",
    },
    schema: maxOccurrencesSchema,
    defaultOptions: [{ maxOccurrences: 0 }],
  },
  create(context) {
    const allowedCount = readMaxOccurrences(context.options);
    let occurrenceCount = 0;

    // Every string, not only className attributes: type also hides in class
    // constants, cva variants and cn() arguments.
    let suppressed: ReadonlySet<number> | undefined;
    const exceedsCeiling = (value: string, line: number): ReadonlyArray<string> | null => {
      const found = rawTypeClasses(value);
      if (found.length === 0) return null;
      suppressed ??= suppressedLines(context.sourceCode, "t3code/no-raw-type-classes");
      if (suppressed.has(line)) return found;
      occurrenceCount++;
      return occurrenceCount > allowedCount ? found : null;
    };
    const message = (found: ReadonlyArray<string>) =>
      MESSAGE.replace("{{classes}}", found.slice(0, 4).join(" "));

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
