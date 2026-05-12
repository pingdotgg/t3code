import { describe, expect, it } from "vitest";

import { createThreadSearchHighlightRehypePlugin } from "./threadSearchHighlight";

describe("createThreadSearchHighlightRehypePlugin", () => {
  it("ignores malformed tree children without crashing", () => {
    const plugin = createThreadSearchHighlightRehypePlugin("alpha", { active: true });
    if (!plugin) {
      throw new Error("Expected highlight plugin to be created.");
    }
    const transform = plugin();

    const tree = {
      type: "root",
      children: [
        undefined,
        {
          type: "element",
          tagName: "p",
          children: [{ type: "text", value: "alpha beta alpha" }],
        },
        {
          type: "element",
          tagName: "hr",
        },
      ],
    };

    expect(() => transform(tree)).not.toThrow();
    expect(tree.children).toEqual(
      expect.arrayContaining([
        {
          type: "element",
          tagName: "p",
          children: [
            {
              type: "element",
              tagName: "mark",
              properties: {
                "data-thread-search-highlight": "active",
                className:
                  "rounded-[0.35rem] bg-warning px-[0.12rem] py-[0.04rem] text-black ring-1 ring-warning/45",
              },
              children: [{ type: "text", value: "alpha" }],
            },
            { type: "text", value: " beta " },
            {
              type: "element",
              tagName: "mark",
              properties: {
                "data-thread-search-highlight": "active",
                className:
                  "rounded-[0.35rem] bg-warning px-[0.12rem] py-[0.04rem] text-black ring-1 ring-warning/45",
              },
              children: [{ type: "text", value: "alpha" }],
            },
          ],
        },
        {
          type: "element",
          tagName: "hr",
        },
      ]),
    );
  });
});
