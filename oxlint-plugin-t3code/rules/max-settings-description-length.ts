import { defineRule, type ESTree } from "@oxlint/plugins";

const MAX_LENGTH = 200;

const MESSAGE = (length: number) =>
  `SettingsRow description is ${length} characters; keep it at ${MAX_LENGTH} or fewer so it stays two lines next to a control. Shorten the copy: keep each fact a user needs and drop restatements.`;

type Node = ESTree.Node | ESTree.JSXElement["children"][number] | null | undefined;

const staticText = (node: Node): string => {
  if (!node) return "";
  switch (node.type) {
    case "Literal":
      return typeof node.value === "string" ? node.value : "";
    case "TemplateLiteral":
      return node.quasis.map((quasi) => quasi.value.cooked ?? "").join("");
    case "JSXText":
      return node.value
        .split(/\r\n|\n|\r/u)
        .map((line, index, lines) => {
          const start = index > 0 ? line.trimStart() : line;
          return index < lines.length - 1 ? start.trimEnd() : start;
        })
        .filter(Boolean)
        .join(" ");
    case "JSXExpressionContainer":
      return node.expression.type === "JSXEmptyExpression" ? "" : staticText(node.expression);
    case "JSXElement":
    case "JSXFragment":
      return node.children.map(staticText).join("");
    case "ConditionalExpression": {
      const consequent = staticText(node.consequent);
      const alternate = staticText(node.alternate);
      return consequent.length >= alternate.length ? consequent : alternate;
    }
    default:
      return "";
  }
};

export default defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description: `Limit SettingsRow descriptions to ${MAX_LENGTH} characters of static text. The column is at most 672px, about 110 characters per line next to a dropdown, so ${MAX_LENGTH} stays two lines.`,
    },
  },
  create(context) {
    return {
      JSXOpeningElement(node) {
        if (node.name.type !== "JSXIdentifier" || node.name.name !== "SettingsRow") return;
        for (const attribute of node.attributes) {
          if (attribute.type !== "JSXAttribute") continue;
          if (attribute.name.type !== "JSXIdentifier" || attribute.name.name !== "description") {
            continue;
          }
          const length = staticText(attribute.value).replace(/\s+/gu, " ").trim().length;
          if (length > MAX_LENGTH) context.report({ node: attribute, message: MESSAGE(length) });
        }
      },
    };
  },
});
