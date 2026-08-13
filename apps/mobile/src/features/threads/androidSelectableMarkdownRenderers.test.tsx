import { isValidElement } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({ Text: "Text" }));

import { createAndroidSelectableMarkdownRenderers } from "./androidSelectableMarkdownRenderers";

describe("createAndroidSelectableMarkdownRenderers", () => {
  it.each(["paragraph", "heading"] as const)(
    "renders %s blocks as partially selectable native text",
    (blockType) => {
      const renderers = createAndroidSelectableMarkdownRenderers({
        paragraph: {},
        heading: () => ({}),
      });
      const renderer = renderers[blockType];
      const Renderer = () => null;
      const element = renderer?.({
        children: null,
        node: {
          type: blockType,
          children: [{ type: "text", content: "select only these words" }],
        },
        Renderer,
        ...(blockType === "heading" ? { level: 2 as const } : {}),
      });

      expect(isValidElement(element)).toBe(true);
      if (!isValidElement(element)) {
        throw new Error("Expected a React element");
      }
      const elementProps = element.props as {
        readonly selectable?: boolean;
        readonly children: ReadonlyArray<{
          readonly type: unknown;
          readonly props: { readonly parentIsText?: boolean };
        }>;
      };
      expect(elementProps).toMatchObject({ selectable: true });
      const child = elementProps.children[0];
      if (!child) {
        throw new Error("Expected a nested text renderer");
      }
      expect(child.type).toBe(Renderer);
      expect(child.props.parentIsText).toBe(true);
    },
  );
});
