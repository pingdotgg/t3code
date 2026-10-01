import { defineRule } from "@oxlint/plugins";

const INTRINSIC_ELEMENT_PATTERN = /^[a-z]/u;

// On these elements the title attribute names the embedded content for
// accessibility (and does not reliably produce a hover tooltip), so the styled
// Tooltip component is not a drop-in replacement.
const TITLE_IS_AN_ACCESSIBLE_NAME = new Set(["embed", "frame", "iframe", "math", "object"]);

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow the native title attribute as a tooltip on intrinsic elements; use the styled Tooltip component.",
    },
  },
  create(context) {
    return {
      JSXOpeningElement(node) {
        if (node.name.type !== "JSXIdentifier") return;
        if (!INTRINSIC_ELEMENT_PATTERN.test(node.name.name)) return;
        if (TITLE_IS_AN_ACCESSIBLE_NAME.has(node.name.name)) return;

        for (const attribute of node.attributes) {
          if (attribute.type !== "JSXAttribute") continue;
          if (attribute.name.type !== "JSXIdentifier") continue;
          if (attribute.name.name !== "title") continue;

          context.report({
            node: attribute,
            message:
              "Do not use the native title attribute as a tooltip. Use Tooltip + TooltipTrigger + TooltipPopup from components/ui/tooltip.",
          });
        }
      },
    };
  },
});
