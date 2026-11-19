import { defineRule } from "@oxlint/plugins";
import * as Option from "effect/Option";

import { getPropertyName, unwrapExpression } from "../utils.ts";

const MESSAGE =
  "Spaced all-caps labels are banned. Use normal casing with the dim or muted text tier.";

function isWideningTracking(token: string): boolean {
  if (/(?:^|:)tracking-(?:wide|wider|widest)$/u.test(token)) return true;
  const arbitrary = /(?:^|:)tracking-\[(?:length:)?([^\]]+)\]$/u.exec(token)?.[1];
  if (!arbitrary) return false;
  const value = /^\+?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?(?:[a-z%]+)?$/iu;
  return value.test(arbitrary) && Number.parseFloat(arbitrary) > 0;
}

function hasSpacedCaps(value: string): boolean {
  const tokens = value.split(/\s+/u);
  return (
    tokens.some((token) => /(?:^|:)uppercase$/u.test(token)) && tokens.some(isWideningTracking)
  );
}

export default defineRule({
  meta: {
    type: "problem",
    docs: { description: "Disallow spaced all-caps labels in web and mobile UI." },
  },
  create(context) {
    return {
      Literal(node) {
        if (typeof node.value === "string" && hasSpacedCaps(node.value)) {
          context.report({ node, message: MESSAGE });
        }
      },
      TemplateLiteral(node) {
        if (node.expressions.length !== 0) return;
        if (hasSpacedCaps(node.quasis[0]?.value.cooked ?? "")) {
          context.report({ node, message: MESSAGE });
        }
      },
      ObjectExpression(node) {
        let uppercase = false;
        let spaced = false;
        for (const property of node.properties) {
          if (property.type !== "Property" || property.kind !== "init") continue;
          if (property.computed && property.key.type !== "Literal") continue;
          const name = Option.getOrUndefined(getPropertyName(property.key));
          const value = Option.getOrUndefined(unwrapExpression(property.value));
          if (!value) continue;
          if (name === "textTransform") {
            uppercase = value.type === "Literal" && value.value === "uppercase";
          }
          if (name === "letterSpacing") {
            spaced =
              (value.type === "Literal" && typeof value.value === "number" && value.value !== 0) ||
              (value.type === "UnaryExpression" &&
                (value.operator === "-" || value.operator === "+") &&
                value.argument.type === "Literal" &&
                typeof value.argument.value === "number" &&
                value.argument.value !== 0);
          }
        }
        if (uppercase && spaced) context.report({ node, message: MESSAGE });
      },
    };
  },
});
