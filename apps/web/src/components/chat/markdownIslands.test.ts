import type { Root } from "hast";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement, Fragment } from "react";
import { describe, expect, it } from "vite-plus/test";

import { renderHastWithIslands } from "./markdownIslands";

describe("renderHastWithIslands", () => {
  it("writes SVG attributes by their SVG names in static HTML", () => {
    const tree: Root = {
      type: "root",
      children: [
        {
          type: "element",
          tagName: "p",
          properties: {},
          children: [
            {
              type: "element",
              tagName: "svg",
              properties: { viewBox: "0 0 1 1" },
              children: [
                {
                  type: "element",
                  tagName: "text",
                  properties: { fontSize: "700", strokeWidth: "2" },
                  children: [{ type: "text", value: "x" }],
                },
              ],
            },
          ],
        },
      ],
    };
    const html = renderToStaticMarkup(
      createElement(
        Fragment,
        null,
        renderHastWithIslands(tree, {
          components: {},
          variant: "",
          isIsland: () => false,
          staticElement: (node) => node,
        }),
      ),
    );
    expect(html).toContain('<text font-size="700" stroke-width="2">x</text>');
    expect(html).toContain('viewBox="0 0 1 1"');
  });
});
