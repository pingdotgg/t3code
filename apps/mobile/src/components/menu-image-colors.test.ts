import { describe, expect, it } from "vite-plus/test";

import { applyDefaultMenuImageColors } from "./menu-image-colors";

describe("applyDefaultMenuImageColors", () => {
  it("tints action images recursively and preserves explicit colors", () => {
    const actions = applyDefaultMenuImageColors(
      [
        { id: "rename", title: "Rename", image: "square.and.pencil" },
        {
          id: "utilities",
          title: "",
          subactions: [{ id: "copy", title: "Copy", image: "doc.on.doc", imageColor: "purple" }],
        },
        {
          id: "delete",
          title: "Delete",
          image: "trash",
          attributes: { destructive: true },
        },
      ],
      { default: "black", destructive: "red" },
    );

    expect(actions[0]?.imageColor).toBe("black");
    expect(actions[1]?.subactions?.[0]?.imageColor).toBe("purple");
    expect(actions[2]?.imageColor).toBe("red");
  });
});
