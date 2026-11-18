import { defineRule, type ESTree } from "@oxlint/plugins";

// Conn: forks rename the app, so copy says `{appName}` and passes `appName()`. See FORK.md.
const APP_NAME = "T3 Code";

const MESSAGE =
  'Hard-coded "T3 Code" in copy. Write `{appName}` and pass `{ appName: appName() }` (desktop main: `appBrand.name`). See FORK.md, "i18n and the app name".';

const isComparison = (node: ESTree.Node) => {
  const parent = (node as { parent?: ESTree.Node }).parent;
  return (
    parent?.type === "BinaryExpression" &&
    (parent.operator === "===" ||
      parent.operator === "!==" ||
      parent.operator === "==" ||
      parent.operator === "!=")
  );
};

// Comments are not copy, and comparing against the default name is how code detects a stock build.
export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow the literal app name in strings and JSX text; use the appName placeholder.",
    },
  },
  create(context) {
    const check = (node: ESTree.Node, text: string | null | undefined) => {
      if (text?.includes(APP_NAME) && !isComparison(node))
        context.report({ node, message: MESSAGE });
    };
    return {
      Literal(node) {
        if (typeof node.value === "string") check(node, node.value);
      },
      TemplateElement(node) {
        check(node, node.value.cooked);
      },
      JSXText(node) {
        check(node, node.value);
      },
    };
  },
});
