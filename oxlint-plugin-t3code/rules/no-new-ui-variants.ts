import { defineRule, type ESTree } from "@oxlint/plugins";
import * as Option from "effect/Option";

import { CEILINGS_COMMAND } from "../classes.ts";
import { getPropertyName } from "../utils.ts";

const properties = (node: unknown): ReadonlyArray<ESTree.ObjectProperty> =>
  typeof node === "object" && node !== null && "type" in node && node.type === "ObjectExpression"
    ? (node as ESTree.ObjectExpression).properties.filter(
        (property): property is ESTree.ObjectProperty => property.type === "Property",
      )
    : [];

const keyName = (property: ESTree.ObjectProperty) =>
  Option.getOrElse(getPropertyName(property.key), () => "?");

const readAllowed = (options: ReadonlyArray<unknown>): ReadonlySet<string> => {
  const [first] = options;
  return new Set(
    typeof first === "object" &&
      first !== null &&
      "allowed" in first &&
      Array.isArray(first.allowed)
      ? first.allowed.filter((name): name is string => typeof name === "string")
      : [],
  );
};

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow cva variants in components/ui that lint-ceilings.json does not list, so a feature's look is not laundered into a primitive.",
    },
    schema: [
      {
        type: "object",
        properties: {
          allowed: {
            type: "array",
            items: { type: "string" },
            description:
              "The file's existing variants as owner.group.key, generated into lint-ceilings.json.",
          },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [{ allowed: [] }],
  },
  create(context) {
    const allowed = readAllowed(context.options);
    const seen = new Set<string>();

    return {
      CallExpression(node) {
        if (node.callee.type !== "Identifier" || node.callee.name !== "cva") return;
        const owner =
          node.parent.type === "VariableDeclarator" && node.parent.id.type === "Identifier"
            ? node.parent.id.name
            : "cva";
        const variants = properties(node.arguments[1]).find(
          (property) => keyName(property) === "variants",
        );
        for (const group of properties(variants?.value)) {
          for (const variant of properties(group.value)) {
            const name = `${owner}.${keyName(group)}.${keyName(variant)}`;
            seen.add(name);
            if (allowed.has(name)) continue;
            // scripts/lint-ceilings.ts reads both messages' names; keep the wording.
            context.report({
              node: variant.key,
              message: `New components/ui variant "${name}". A look that belongs to one feature stays in that feature's component; a primitive gains a variant only for a look every feature can use, with a maintainer's sign-off. See docs/internals/web-ui.md#building-or-porting-ui.`,
            });
          }
        }
      },
      "Program:exit"(node) {
        const gone = [...allowed].filter((name) => !seen.has(name)).sort();
        if (gone.length === 0) return;
        context.report({
          node,
          message: `Variants listed in lint-ceilings.json no longer exist: ${gone.join(", ")}. Run \`${CEILINGS_COMMAND}\`.`,
        });
      },
    };
  },
});
