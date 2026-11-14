import { describe, expect, it } from "vite-plus/test";

import { workGroupImageGallery } from "./markdownImageGallery";

const item = (name: string) => ({ src: `https://assets.test/${name}`, name });

describe("workGroupImageGallery", () => {
  it("pages the clicked image through the group's resolved images", () => {
    const clicked = { ...item("second.png"), src: "https://assets.test/second.png#fresh" };
    const viewed = [
      { path: "/repo/first.png", item: item("first.png") },
      { path: "/repo/pending.png", item: null },
      { path: "/repo/second.png", item: item("second.png") },
      { path: "/repo/third.png", item: item("third.png") },
    ];
    expect(
      workGroupImageGallery(viewed, "/repo/second.png", { images: [clicked], index: 0 }),
    ).toEqual({ images: [item("first.png"), clicked, item("third.png")], index: 1 });
    const single = { images: [clicked], index: 0 };
    expect(workGroupImageGallery(viewed, "/repo/other.png", single)).toBe(single);
  });
});
