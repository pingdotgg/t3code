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

  it("preserves distinct paragraph and heading styles", () => {
    const renderers = createAndroidSelectableMarkdownRenderers({
      paragraph: { color: "#111111" },
      heading: () => ({ color: "#222222" }),
    });
    const Renderer = () => null;
    const baseProps = {
      children: null,
      Renderer,
    };
    const paragraph = renderers.paragraph?.({
      ...baseProps,
      node: { type: "paragraph", children: [] },
    });
    const heading = renderers.heading?.({
      ...baseProps,
      level: 2,
      node: { type: "heading", children: [] },
    });

    expect(isValidElement(paragraph) && paragraph.props).toMatchObject({
      style: { color: "#111111" },
    });
    expect(isValidElement(heading) && heading.props).toMatchObject({
      style: { color: "#222222" },
    });
  });
});
