import { defineRule, type ESTree } from "@oxlint/plugins";
import * as Option from "effect/Option";

import { unwrapExpression } from "../utils.ts";

const SCROLLS_VERTICALLY = /(?:^|:)overflow-(?:y-)?auto$/u;
// Either utility keeps the content box the same width whether or not the scrollbar shows. Both
// exemptions must be unprefixed: a variant such as lg: leaves every other state unprotected.
const RESERVES_GUTTER =
  /^(?:scrollbar-gutter-(?:stable|both)|\[scrollbar-gutter:stable(?:_both-edges)?\])$/u;
const HIDES_SCROLLBAR = /^\[scrollbar-width:none\]$/u;
const CENTERED_BY_MARGIN = /(?:^|:)mx?-auto$/u;
const COLUMN = /(?:^|:)flex-col(?:-reverse)?$/u;
const ALWAYS_COLUMN = /^flex-col(?:-reverse)?$/u;
const ROW = /(?:^|:)flex-row(?:-reverse)?$/u;
const CENTERS_COLUMN_ITEMS = /(?:^|:)(?:items-center(?:-safe)?|place-items-center)$/u;
const CENTERS_ROW_ITEMS =
  /(?:^|:)(?:justify-center(?:-safe)?|\[justify-content:safe_center\]|place-items-center|place-content-center)$/u;

interface ClassNames {
  /** Classes that apply in at least one render. */
  readonly possible: Set<string>;
  /** Classes that apply in every render, outside any conditional branch. */
  readonly always: Set<string>;
}

/**
 * The class names a className value can produce: string literals, template text, and the
 * branches and arguments of conditionals and cn()-style calls. Conditions themselves are skipped.
 */
function collectClassNames(node: unknown, classNames: ClassNames, always: boolean) {
  const expression = unwrapExpression(node);
  if (Option.isNone(expression)) return;
  const value = expression.value;

  const addAll = (text: string | null) => {
    for (const className of text?.split(/\s+/u) ?? []) {
      if (!className) continue;
      classNames.possible.add(className);
      if (always) classNames.always.add(className);
    }
  };

  switch (value.type) {
    case "Literal":
      if (typeof value.value === "string") addAll(value.value);
      return;
    case "TemplateLiteral":
      value.quasis.forEach((quasi, index) => {
        // A token touching an interpolation is only part of a class name, such as `${prefix}x`.
        const tokens = (quasi.value.cooked ?? "").split(/\s+/u);
        if (index > 0) tokens.shift();
        if (!quasi.tail) tokens.pop();
        addAll(tokens.join(" "));
      });
      for (const nested of value.expressions) collectClassNames(nested, classNames, always);
      return;
    case "JSXExpressionContainer":
      collectClassNames(value.expression, classNames, always);
      return;
    case "ConditionalExpression":
      collectClassNames(value.consequent, classNames, false);
      collectClassNames(value.alternate, classNames, false);
      return;
    case "LogicalExpression":
      collectClassNames(value.left, classNames, false);
      collectClassNames(value.right, classNames, false);
      return;
    case "ArrayExpression":
      for (const element of value.elements) collectClassNames(element, classNames, always);
      return;
    case "CallExpression":
      for (const argument of value.arguments) collectClassNames(argument, classNames, always);
      return;
  }
}

function classNamesOf(element: ESTree.JSXElement): ClassNames {
  const classNames: ClassNames = { possible: new Set(), always: new Set() };
  for (const attribute of element.openingElement.attributes) {
    if (
      attribute.type === "JSXAttribute" &&
      attribute.name.type === "JSXIdentifier" &&
      attribute.name.name === "className"
    ) {
      collectClassNames(attribute.value, classNames, true);
    }
  }
  return classNames;
}

const hasClass = (classNames: ReadonlySet<string>, pattern: RegExp) =>
  [...classNames].some((className) => pattern.test(className));

/**
 * Reports a native vertical scroller that centers its content without reserving the scrollbar
 * lane. A classic scrollbar narrows the scroller when it appears, so centered content jumps by
 * half its width whenever the content grows past the fold.
 */
export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Require scrollbar-gutter-both on overflow-auto scrollers that center their content, so it does not shift when the scrollbar appears.",
    },
  },
  create(context) {
    const reported = new Set<ESTree.JSXElement>();

    const report = (scroller: ESTree.JSXElement, { always }: ClassNames) => {
      if (reported.has(scroller)) return;
      if (hasClass(always, RESERVES_GUTTER) || hasClass(always, HIDES_SCROLLBAR)) return;
      reported.add(scroller);
      context.report({
        node: scroller.openingElement,
        message:
          "This scroller centers its content, which shifts sideways when the scrollbar appears. Add scrollbar-gutter-both.",
      });
    };

    return {
      JSXElement(node) {
        const classNames = classNamesOf(node);
        const { possible } = classNames;
        if (possible.size === 0) return;

        if (hasClass(possible, SCROLLS_VERTICALLY)) {
          // A responsive or conditional direction can render as either axis, so check both.
          const centersColumn =
            hasClass(possible, COLUMN) && hasClass(possible, CENTERS_COLUMN_ITEMS);
          const centersRow =
            (!hasClass(classNames.always, ALWAYS_COLUMN) || hasClass(possible, ROW)) &&
            hasClass(possible, CENTERS_ROW_ITEMS);
          if (centersColumn || centersRow) report(node, classNames);
        }

        if (!hasClass(possible, CENTERED_BY_MARGIN)) return;
        // The nearest enclosing scroller is the one whose scrollbar moves this element.
        for (let ancestor: ESTree.Node | null = node.parent; ancestor; ancestor = ancestor.parent) {
          // An element passed as a prop renders wherever that component puts it.
          if (ancestor.type === "JSXAttribute") return;
          if (ancestor.type !== "JSXElement") continue;
          const ancestorClassNames = classNamesOf(ancestor);
          if (!hasClass(ancestorClassNames.possible, SCROLLS_VERTICALLY)) continue;
          report(ancestor, ancestorClassNames);
          return;
        }
      },
    };
  },
});
