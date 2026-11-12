import { defineRule } from "@oxlint/plugins";

// LegendList takes a render function; KeyboardAwareLegendList takes the component itself.
const SCROLL_COMPONENT_PROP: Readonly<Record<string, string>> = {
  LegendList: "renderScrollComponent",
  AnimatedLegendList: "renderScrollComponent",
  KeyboardAwareLegendList: "ScrollViewComponent",
};

// A screen's list must scroll in a scroll view registered with its header, or the header loses
// its scroll-edge blur (and, on the iPhone Duo, the blur's reach under the vertical bar).
export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Require mobile lists to render through a header-registered scroll view (renderScrollComponent).",
    },
  },
  create(context) {
    return {
      JSXOpeningElement(node) {
        if (node.name.type !== "JSXIdentifier") return;
        const prop = SCROLL_COMPONENT_PROP[node.name.name];
        if (!prop) return;
        const registered = node.attributes.some(
          (attribute) =>
            attribute.type === "JSXAttribute" &&
            attribute.name.type === "JSXIdentifier" &&
            attribute.name.name === prop,
        );
        if (registered) return;
        context.report({
          node,
          message: `Pass ${prop} so the list scrolls in a header-registered scroll view: NativeScrollView on iOS, or a component wrapping NativeScrollViewMarker. A list nested in another scroll surface or sheet can suppress this with a reason.`,
        });
      },
    };
  },
});
