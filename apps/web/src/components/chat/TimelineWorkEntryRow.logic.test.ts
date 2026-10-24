import type { Root, RootContent } from "mdast";
import { parseMarkdownWithMath } from "@t3tools/shared/markdownMath";
import { describe, expect, it } from "vite-plus/test";

import { remarkThoughtPreview, THOUGHT_PREVIEW_MAX_LENGTH } from "./TimelineWorkEntryRow.logic";

const FRAGMENT = "plain **fragment** ";

function preview(source: string) {
  const tree = parseMarkdownWithMath(source);
  remarkThoughtPreview("Thought")(tree);
  return tree.children;
}

describe("collapsed reasoning preview", () => {
  it("bounds fragment visits for a 190k-character reasoning block", () => {
    const source = FRAGMENT.repeat(10_000);
    expect(source).toHaveLength(190_000);
    const tree = parseMarkdownWithMath(source);
    let valueReads = 0;
    const observe = (node: Root | RootContent) => {
      if ("value" in node) {
        const value = node.value;
        Object.defineProperty(node, "value", {
          get() {
            valueReads += 1;
            return value;
          },
          configurable: true,
        });
      }
      if ("children" in node) node.children.forEach(observe);
    };
    observe(tree);

    remarkThoughtPreview("Thought")(tree);

    // A collapsed label must stop consuming fragments once its preview is full.
    expect(valueReads).toBeLessThan(2_048);
  });

  it("produces the same preview from an early bounded prefix and the full input", () => {
    const prefix = `## Plan\n\nUse **norm** $|x|$ before proceeding.\n\n${FRAGMENT.repeat(512)}`;
    const bounded = preview(prefix);
    const full = preview(prefix + FRAGMENT.repeat(10_000));
    const text = (children: RootContent[]) =>
      children.map((node) => ("value" in node ? node.value : "")).join("");

    // Check lengths first to keep a failing assertion from printing the entire trace.
    expect(text(full).length).toBe(text(bounded).length);
    expect(full.map((node) => node.type)).toEqual(bounded.map((node) => node.type));
    expect(text(full)).toBe(text(bounded));
    expect(full.some((node) => node.type === "inlineMath")).toBe(true);
  });
});

describe("preview parity and cut boundaries", () => {
  it("preserves whitespace across nested inline and block boundaries below the cap", () => {
    const children = preview(
      "  ## Plan\n\nUse **bold** *words* and `code` here.\n\n> quoted\n> text\n\n- first\n- second\n\n![an image](image.png)\n\n<div>hidden</div>\n\n[ref]: /hidden",
    );
    expect(children).toEqual([
      {
        type: "text",
        value: "Plan Use bold words and code here. quoted text first second an image",
      },
    ]);
  });

  it("keeps inline and display math with text whitespace on both sides", () => {
    const children = preview("Before **bold** $x^2$ after.\n\n$$\ny = 2\n$$\n\nEnd.");
    expect(children.map((node) => node.type)).toEqual([
      "text",
      "inlineMath",
      "text",
      "inlineMath",
      "text",
    ]);
    expect(children.map((node) => ("value" in node ? node.value : ""))).toEqual([
      "Before bold ",
      "x^2",
      " after. ",
      "y = 2",
      " End.",
    ]);
    for (const child of children) {
      if (child.type !== "inlineMath") continue;
      expect(child.data).toEqual({
        hName: "code",
        hProperties: { className: ["language-math", "math-inline"] },
        hChildren: [{ type: "text", value: child.value }],
      });
      expect(child.position).toBeDefined();
    }
  });

  it.each(["", "   ", "<div>hidden</div>", "[ref]: /hidden"])(
    "uses the fallback for %j",
    (source) => {
      expect(preview(source)).toEqual([{ type: "text", value: "Thought" }]);
    },
  );

  it("bounds a single huge text node and does not read the following node", () => {
    const tree: Root = {
      type: "root",
      children: [
        { type: "text", value: "x".repeat(190_000) },
        {
          type: "text",
          get value(): string {
            throw new Error("read beyond cap");
          },
        },
      ],
    };
    remarkThoughtPreview("Thought")(tree);
    expect(tree.children).toEqual([
      { type: "text", value: "x".repeat(THOUGHT_PREVIEW_MAX_LENGTH) },
    ]);
  });

  it("cuts across fragments exactly at the cap without consuming trailing math", () => {
    const tree: Root = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [
            { type: "text", value: "x".repeat(THOUGHT_PREVIEW_MAX_LENGTH - 2) },
            { type: "strong", children: [{ type: "text", value: "yz beyond" }] },
            {
              type: "inlineMath",
              get value(): string {
                throw new Error("read beyond cap");
              },
            },
          ],
        },
      ],
    };
    remarkThoughtPreview("Thought")(tree);
    expect(tree.children).toEqual([
      { type: "text", value: `${"x".repeat(THOUGHT_PREVIEW_MAX_LENGTH - 2)}yz` },
    ]);
  });
});
