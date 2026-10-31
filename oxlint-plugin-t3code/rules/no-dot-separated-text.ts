import { defineRule, type ESTree } from "@oxlint/plugins";

const MESSAGE =
  "Show one short label. Put secondary details in a tooltip or in layout, not a ' · ' joined string.";
const SEPARATOR = /[·•]/u;
const TEXT = /[^\s·•]/u;

function isRenderedExpression(node: ESTree.Node): boolean {
  let parent = node.parent;
  while (parent) {
    if (parent.type === "JSXExpressionContainer" || parent.type === "JSXAttribute") return true;
    if (
      parent.type === "VariableDeclarator" ||
      parent.type === "ExpressionStatement" ||
      parent.type === "ReturnStatement"
    ) {
      return false;
    }
    parent = parent.parent;
  }
  return false;
}

function isJoinArgument(node: ESTree.Node): boolean {
  const parent = node.parent;
  return (
    parent?.type === "CallExpression" &&
    parent.arguments[0] === node &&
    parent.callee.type === "MemberExpression" &&
    ((!parent.callee.computed &&
      parent.callee.property.type === "Identifier" &&
      parent.callee.property.name === "join") ||
      (parent.callee.computed &&
        parent.callee.property.type === "Literal" &&
        parent.callee.property.value === "join"))
  );
}

export default defineRule({
  meta: {
    type: "problem",
    docs: { description: "Disallow dot-separated labels and metadata in web UI." },
  },
  create(context) {
    if (/\.(?:test|spec)\.[^/\\]+$/u.test(context.filename)) return {};

    const check = (node: ESTree.Node, text: string, left = false, right = false) => {
      if (!SEPARATOR.test(text)) return;
      const container = node.type === "TemplateElement" ? node.parent : node;
      for (let index = 0; index < text.length; index += 1) {
        const glyph = text[index];
        if (glyph !== "·" && glyph !== "•") continue;
        const hasLeft = left || TEXT.test(text.slice(0, index));
        const hasRight = right || TEXT.test(text.slice(index + 1));
        // A bullet that starts a line of document/list content is not a metadata separator.
        const lineStart = text.lastIndexOf("\n", index - 1) + 1;
        const hasLeftOnLine = (lineStart === 0 && left) || TEXT.test(text.slice(lineStart, index));
        if (glyph === "•" && !hasLeftOnLine && hasRight) continue;
        if (
          hasLeft ||
          hasRight ||
          isJoinArgument(container) ||
          node.type === "JSXText" ||
          isRenderedExpression(container)
        ) {
          context.report({ node, message: MESSAGE });
          return;
        }
      }
    };

    return {
      Literal(node) {
        if (typeof node.value === "string") check(node, node.value);
      },
      TemplateElement(node) {
        const template = node.parent;
        if (template.type !== "TemplateLiteral") return;
        const index = template.quasis.indexOf(node);
        check(
          node,
          node.value.cooked ?? node.value.raw,
          index > 0,
          index < template.expressions.length,
        );
      },
      JSXText(node) {
        // Siblings such as `{name}` render content around a glyph in this text node.
        const parent = node.parent;
        const siblings =
          parent.type === "JSXElement" || parent.type === "JSXFragment" ? parent.children : [];
        const index = siblings.indexOf(node);
        const rendersContent = (sibling: (typeof siblings)[number]) =>
          sibling.type === "JSXText"
            ? TEXT.test(sibling.value)
            : !(
                sibling.type === "JSXExpressionContainer" &&
                sibling.expression.type === "JSXEmptyExpression"
              );
        check(
          node,
          node.value
            .replace(/&(?:middot|#0*183|#x0*b7);/giu, "·")
            .replace(/&(?:bull|#0*8226|#x0*2022);/giu, "•"),
          siblings.slice(0, index).some(rendersContent),
          siblings.slice(index + 1).some(rendersContent),
        );
      },
    };
  },
});
