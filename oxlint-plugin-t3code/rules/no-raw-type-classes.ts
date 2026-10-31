import { defineRule } from "@oxlint/plugins";

// Tailwind's size scale, the old 2xs/3xs steps and arbitrary sizes such as
// text-[13px]. A role (text-label, text-meta …) carries its own size and weight.
const RAW_SIZE =
  /^text-(?:xs|sm|base|lg|xl|[2-9]xl|2xs|3xs|\[(?:length:)?\d[\d.]*(?:px|rem|em)\])(?:\/[\w.[\]()-]+)?$/u;
const RAW_WEIGHT = /^font-(?:thin|extralight|light|normal|medium|semibold|bold|extrabold|black)$/u;

/** The class without variants (`hover:`, `sm:`, `[&_svg]:`) or important marks. */
function baseClass(token: string): string {
  let depth = 0;
  let start = 0;
  for (let index = 0; index < token.length; index++) {
    const char = token[index];
    if (char === "[" || char === "(") depth++;
    else if (char === "]" || char === ")") depth--;
    else if (char === ":" && depth === 0) start = index + 1;
  }
  return token.slice(start).replace(/^!|!$/gu, "");
}

export function rawTypeClasses(value: string): ReadonlyArray<string> {
  return value
    .split(/\s+/u)
    .filter((token) => token.length > 0)
    .filter((token) => {
      const base = baseClass(token);
      return RAW_SIZE.test(base) || RAW_WEIGHT.test(base);
    });
}

const readMaxOccurrences = (options: ReadonlyArray<unknown>): number => {
  const [first] = options;
  return typeof first === "object" &&
    first !== null &&
    "maxOccurrences" in first &&
    typeof first.maxOccurrences === "number"
    ? first.maxOccurrences
    : 0;
};

const MESSAGE =
  "Raw type classes ({{classes}}). Render <Text variant> from components/ui/text, or use a text-{role} class (title, prompt, label, body, meta, caption, micro) so type follows the design system's seven roles.";

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow Tailwind font-size and font-weight classes outside components/ui; use the type roles.",
    },
    schema: [
      {
        type: "object",
        properties: {
          maxOccurrences: {
            type: "integer",
            minimum: 0,
            description:
              "Legacy debt ceiling for this file: strings with raw type classes beyond this count are reported.",
          },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [{ maxOccurrences: 0 }],
  },
  create(context) {
    const allowedCount = readMaxOccurrences(context.options);
    let occurrenceCount = 0;

    // Every string, not only className attributes: type also hides in class
    // constants, cva variants and cn() arguments.
    const exceedsCeiling = (value: string): ReadonlyArray<string> | null => {
      const found = rawTypeClasses(value);
      if (found.length === 0) return null;
      occurrenceCount++;
      return occurrenceCount > allowedCount ? found : null;
    };
    const message = (found: ReadonlyArray<string>) =>
      MESSAGE.replace("{{classes}}", found.slice(0, 4).join(" "));

    return {
      Literal(node) {
        if (typeof node.value !== "string") return;
        const found = exceedsCeiling(node.value);
        if (found) context.report({ node, message: message(found) });
      },
      TemplateElement(node) {
        const found = exceedsCeiling(node.value.cooked ?? "");
        if (found) context.report({ node, message: message(found) });
      },
    };
  },
});
