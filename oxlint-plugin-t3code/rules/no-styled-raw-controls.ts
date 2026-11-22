import { defineRule, type ESTree } from "@oxlint/plugins";

import {
  baseClass,
  ceilingMismatch,
  classStrings,
  classTokens,
  maxOccurrencesSchema,
  readMaxOccurrences,
  suppressedLines,
  type ResolveConstant,
} from "../classes.ts";

// Interactive intrinsic elements. A styled one is a hand-built Button, Input,
// Select or link: it skips the components/ui variants, so it drifts from every
// other control and escapes shadcn/no-restyle, which only checks ui components.
const RAW_CONTROLS = new Set(["a", "button", "input", "select", "summary", "textarea"]);
// Intrinsic elements that can carry a control's look for it; icons and images size themselves.
const WRAPPER = /^(?!svg$|img$)[a-z]/u;

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
    const classAttribute = (opening: ESTree.JSXOpeningElement) => {
      const attribute = opening.attributes.find(
        (candidate): candidate is ESTree.JSXAttribute =>
          candidate.type === "JSXAttribute" &&
          candidate.name.type === "JSXIdentifier" &&
          candidate.name.name === "className" &&
          candidate.value !== null,
      );
      return attribute && { attribute, line: attribute.loc.start.line };
    };
    // Checked once the whole file is read, so a constant declared below its use still counts.
    const controls: Array<{
      element: string;
      own: ReturnType<typeof classAttribute>;
      child: { name: string; classes: ReturnType<typeof classAttribute> } | undefined;
    }> = [];

    return {
      JSXElement(node) {
        const opening = node.openingElement;
        if (opening.name.type !== "JSXIdentifier" || !RAW_CONTROLS.has(opening.name.name)) return;
        // Classes moved onto a lone wrapper still style the control: <summary><span className=…>.
        const children = node.children.filter(
          (child) => child.type !== "JSXText" || child.value.trim() !== "",
        );
        const only = children.length === 1 ? children[0] : undefined;
        const childName =
          only?.type === "JSXElement" && only.openingElement.name.type === "JSXIdentifier"
            ? only.openingElement.name.name
            : undefined;
        controls.push({
          element: opening.name.name,
          own: classAttribute(opening),
          child:
            only?.type === "JSXElement" && childName !== undefined && WRAPPER.test(childName)
              ? { name: childName, classes: classAttribute(only.openingElement) }
              : undefined,
        });
      },
      "Program:exit"() {
        let occurrenceCount = 0;
        const suppressed = suppressedLines(context.sourceCode, "t3code/no-styled-raw-controls");
        const appearanceOf = (classes: ReturnType<typeof classAttribute>) =>
          classes
            ? classStrings(classes.attribute.value, resolveConstant).flatMap(appearanceClasses)
            : [];
        for (const { element, own, child } of controls) {
          const ownFound = appearanceOf(own);
          const childFound = appearanceOf(child?.classes);
          const target = ownFound.length > 0 ? own : child?.classes;
          if (target === undefined || ownFound.length + childFound.length === 0) continue;
          const found = ownFound.length > 0 ? ownFound : childFound;

          if (!suppressed.has(target.line)) occurrenceCount++;
          if (!suppressed.has(target.line) && occurrenceCount <= allowedCount) continue;

          const replacement =
            element === "a"
              ? "Button render={<a />} or InlineButton"
              : element === "input" || element === "textarea" || element === "select"
                ? "Input, Textarea or Select"
                : "Button with a variant and size";
          const how =
            ownFound.length > 0
              ? "is styled by hand"
              : `is styled through its only child <${child?.name}>`;
          context.report({
            node: target.attribute,
            message: `<${element}> ${how} (${found.slice(0, 4).join(" ")}). Render ${replacement} from components/ui; only layout classes belong on a raw control.`,
          });
        }
        const mismatch = ceilingMismatch(allowedCount, occurrenceCount);
        if (mismatch) context.report(mismatch);
      },
    };
  },
});
