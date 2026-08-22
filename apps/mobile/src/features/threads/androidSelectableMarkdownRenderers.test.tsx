import { isValidElement, type ReactElement } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({ Text: "Text" }));
vi.mock("react-native-nitro-markdown", () => ({ TaskListItem: "TaskListItem" }));

import {
  createAndroidSelectableHeadingStyle,
  createAndroidSelectableMarkdownRenderers,
} from "./androidSelectableMarkdownRenderers";

const STYLES = {
  paragraph: { color: "#111111" },
  heading: () => ({ color: "#222222" }),
  listItemText: { color: "#333333" },
};

function assertElement(value: unknown): ReactElement {
  if (!isValidElement(value)) {
    throw new Error("Expected a React element");
  }
  return value;
}

describe("createAndroidSelectableMarkdownRenderers", () => {
  it.each(["paragraph", "heading"] as const)(
    "renders %s blocks as partially selectable native text",
    (blockType) => {
      const renderers = createAndroidSelectableMarkdownRenderers(STYLES);
      const renderer = renderers[blockType];
      const Renderer = () => null;
      const element = assertElement(
        renderer?.({
          children: null,
          node: {
            type: blockType,
            children: [{ type: "text", content: "select only these words" }],
          },
          Renderer,
          ...(blockType === "heading" ? { level: 2 as const } : {}),
        }),
      );

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
    const renderers = createAndroidSelectableMarkdownRenderers(STYLES);
    const Renderer = () => null;
    const baseProps = { children: null, Renderer };
    const paragraph = renderers.paragraph?.({
      ...baseProps,
      node: { type: "paragraph", children: [] },
    });
    const heading = renderers.heading?.({
      ...baseProps,
      level: 2,
      node: { type: "heading", children: [] },
    });

    expect(assertElement(paragraph).props).toMatchObject({
      style: { color: "#111111" },
    });
    expect(assertElement(heading).props).toMatchObject({
      style: { color: "#222222" },
    });
  });

  it("wraps tight list item inline runs in selectable text and passes blocks through", () => {
    const renderers = createAndroidSelectableMarkdownRenderers(STYLES);
    const Renderer = () => null;
    const element = assertElement(
      renderers.list_item?.({
        children: null,
        Renderer,
        node: {
          type: "list_item",
          children: [
            { type: "text", content: "inline " },
            { type: "bold", children: [{ type: "text", content: "run" }] },
            { type: "list", children: [] },
          ],
        },
      }),
    );

    const output = (element.props as { children: ReadonlyArray<unknown> }).children;
    expect(output).toHaveLength(2);

    const run = assertElement(output[0]);
    const runProps = run.props as {
      readonly selectable?: boolean;
      readonly style?: unknown;
      readonly children: ReadonlyArray<{
        readonly type: unknown;
        readonly props: { readonly parentIsText?: boolean };
      }>;
    };
    expect(runProps).toMatchObject({
      selectable: true,
      style: { color: "#333333" },
    });
    expect(runProps.children).toHaveLength(2);
    for (const inline of runProps.children) {
      expect(inline.type).toBe(Renderer);
      expect(inline.props.parentIsText).toBe(true);
    }

    const block = assertElement(output[1]);
    expect(block.type).toBe(Renderer);
    expect(block.props).toMatchObject({ parentIsText: false, inListItem: true });
  });

  it("keeps task list checkbox chrome while making content selectable", () => {
    const renderers = createAndroidSelectableMarkdownRenderers(STYLES);
    const Renderer = () => null;
    const element = assertElement(
      renderers.task_list_item?.({
        children: null,
        Renderer,
        checked: true,
        node: {
          type: "task_list_item",
          children: [{ type: "text", content: "done thing" }],
        },
      }),
    );

    expect(element.type).toBe("TaskListItem");
    expect(element.props).toMatchObject({ checked: true });
    const content = (element.props as { children: ReadonlyArray<unknown> }).children;
    const run = assertElement(content[0]);
    expect((run.props as { selectable?: boolean }).selectable).toBe(true);
  });
  it.each(["image", "math_inline"] as const)(
    "leaves paragraphs holding a %s node to the library renderer",
    (blockType) => {
      const renderers = createAndroidSelectableMarkdownRenderers(STYLES);
      const output = renderers.paragraph?.({
        children: null,
        Renderer: () => null,
        node: {
          type: "paragraph",
          children: [{ type: "text", content: "look: " }, { type: blockType }],
        },
      });

      expect(output).toBeUndefined();
    },
  );

  it.each(["list_item", "task_list_item"] as const)(
    "leaves %s nodes holding inline math to the library renderer",
    (itemType) => {
      const renderers = createAndroidSelectableMarkdownRenderers(STYLES);
      const output = renderers[itemType]?.({
        children: null,
        Renderer: () => null,
        checked: false,
        node: {
          type: itemType,
          children: [{ type: "text", content: "value " }, { type: "math_inline" }],
        },
      });

      expect(output).toBeUndefined();
    },
  );

  it("still splits list items around block children that are safe outside text", () => {
    const renderers = createAndroidSelectableMarkdownRenderers(STYLES);
    const element = assertElement(
      renderers.list_item?.({
        children: null,
        Renderer: () => null,
        node: {
          type: "list_item",
          children: [{ type: "text", content: "caption" }, { type: "image" }],
        },
      }),
    );

    const output = (element.props as { children: ReadonlyArray<unknown> }).children;
    expect(output).toHaveLength(2);
    expect((assertElement(output[1]).props as { parentIsText?: boolean }).parentIsText).toBe(false);
  });
});

describe("createAndroidSelectableHeadingStyle", () => {
  const FONT_SIZES = { h1: 24, h2: 20, h3: 18, h4: 16, h5: 15, h6: 14 };
  const headingStyle = createAndroidSelectableHeadingStyle({
    fontSizes: FONT_SIZES,
    borderColor: "#cccccc",
    borderSpacing: 4,
    override: { color: "#222222", marginTop: 18, marginBottom: 8 },
  });

  it("keeps the level-one rule the library draws", () => {
    expect(headingStyle(1)).toMatchObject({
      borderBottomWidth: 1,
      borderBottomColor: "#cccccc",
      paddingBottom: 4,
      fontSize: 24,
      lineHeight: 24 * 1.3,
      letterSpacing: -0.6,
    });
  });

  it("keeps per-level letter spacing and android font padding without a rule", () => {
    expect(headingStyle(2)).toMatchObject({ letterSpacing: -0.4, includeFontPadding: false });
    expect(headingStyle(3)).toMatchObject({ letterSpacing: -0.2, includeFontPadding: false });
    expect(headingStyle(6)).toMatchObject({ fontSize: 14, letterSpacing: -0.2 });
    for (const level of [2, 3, 4, 5, 6]) {
      expect(headingStyle(level)).not.toHaveProperty("borderBottomWidth");
    }
  });

  it("applies the node style override last, as the library does", () => {
    expect(headingStyle(1)).toMatchObject({ color: "#222222", marginTop: 18, marginBottom: 8 });
  });
});
