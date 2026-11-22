import { defineRule } from "@oxlint/plugins";

import {
  baseClass,
  classStrings,
  classTokens,
  maxOccurrencesSchema,
  readMaxOccurrences,
  type ResolveConstant,
} from "../classes.ts";

// Interactive intrinsic elements. A styled one is a hand-built Button, Input,
// Select or link: it skips the components/ui variants, so it drifts from every
// other control and escapes shadcn/no-restyle, which only checks ui components.
const RAW_CONTROLS = new Set(["a", "button", "input", "select", "summary", "textarea"]);

// Appearance belongs to UI primitives; layout, overflow and resets stay on raw controls.
const APPEARANCE = [
  /^text-(?!(?:left|center|right|justify|start|end|wrap|nowrap|balance|pretty|ellipsis|clip)$)/u,
  /^(?:font|tracking|leading|decoration|underline-offset)-/u,
  /^(?:underline|italic|uppercase|lowercase|capitalize)$/u,
  /^p[xytrblse]?-/u,
  /^(?:gap|space-[xy])-/u,
  // rounded-[inherit] follows the parent's shape rather than choosing one.
  /^rounded(?:-(?!\[inherit\]$)|$)/u,
  /^border(?:-|$)/u,
  /^ring(?:-|$)/u,
  /^outline-(?!(?:none|hidden)$)/u,
  /^(?:bg|from|via|to|fill|stroke|caret|accent|placeholder)-/u,
  // opacity-0 hides a native control under a styled one (a file or range input),
  // so it is a hit target, not a look.
  /^(?:shadow|inset-shadow|drop-shadow|backdrop|blur)(?:-|$)/u,
  /^opacity-(?!0$)/u,
  /^(?:surface|kbd)-/u,
];

export function appearanceClasses(value: string): ReadonlyArray<string> {
  return classTokens(value).filter((token) =>
    APPEARANCE.some((pattern) => pattern.test(baseClass(token))),
  );
}

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow appearance classes on raw interactive elements; render the components/ui control instead.",
    },
    schema: maxOccurrencesSchema,
    defaultOptions: [{ maxOccurrences: 0 }],
  },
  create(context) {
    const allowedCount = readMaxOccurrences(context.options);
    const resolveConstant: ResolveConstant = (identifier) => {
      let scope = context.sourceCode.getScope(identifier);
      while (true) {
        const variable = scope.set.get(identifier.name);
        if (variable !== undefined) {
          const definition = variable.defs.find((def) => def.type === "Variable");
          return definition?.parent?.type === "VariableDeclaration" &&
            definition.parent.kind === "const" &&
            definition.node.type === "VariableDeclarator" &&
            definition.node.id.type === "Identifier"
            ? definition.node
            : undefined;
        }
        if (scope.upper === null) return undefined;
        scope = scope.upper;
      }
    };
    // Checked once the whole file is read, so a constant declared below its use still counts.
    const classNames: Array<{
      element: string;
      value: unknown;
      report: (message: string) => void;
    }> = [];

    return {
      JSXOpeningElement(node) {
        if (node.name.type !== "JSXIdentifier" || !RAW_CONTROLS.has(node.name.name)) return;
        const element = node.name.name;

        for (const attribute of node.attributes) {
          if (attribute.type !== "JSXAttribute" || attribute.name.type !== "JSXIdentifier")
            continue;
          if (attribute.name.name !== "className" || attribute.value === null) continue;
          classNames.push({
            element,
            value: attribute.value,
            report: (message) => context.report({ node: attribute, message }),
          });
        }
      },
      "Program:exit"() {
        let occurrenceCount = 0;
        for (const { element, value, report } of classNames) {
          const found = classStrings(value, resolveConstant).flatMap(appearanceClasses);
          if (found.length === 0) continue;

          occurrenceCount++;
          if (occurrenceCount <= allowedCount) continue;

          const replacement =
            element === "a"
              ? "Button render={<a />} or InlineButton"
              : element === "input" || element === "textarea" || element === "select"
                ? "Input, Textarea or Select"
                : "Button with a variant and size";
          report(
            `<${element}> is styled by hand (${found.slice(0, 4).join(" ")}). Render ${replacement} from components/ui; only layout classes belong on a raw control.`,
          );
        }
      },
    };
  },
});
