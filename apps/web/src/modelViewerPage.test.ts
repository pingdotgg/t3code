import { describe, expect, it } from "vite-plus/test";

import { readModelViewerPageParams } from "./modelViewerPage";

const origin = "http://127.0.0.1:3773";
const read = (fragment: Record<string, string>) =>
  readModelViewerPageParams({ origin, hash: `#${new URLSearchParams(fragment).toString()}` });

describe("readModelViewerPageParams", () => {
  it("reads a same-origin mesh link and takes the format from its name", () => {
    expect(
      read({ src: `${origin}/api/assets/abc?token=1`, name: "part.STL", appearance: "dark" }),
    ).toEqual({
      src: `${origin}/api/assets/abc?token=1`,
      name: "part.STL",
      format: "stl",
      appearance: "dark",
    });
  });

  it("accepts Blender files, whose link serves their exported geometry", () => {
    expect(read({ src: `${origin}/a`, name: "scene.blend" })?.format).toBe("blend");
  });

  it("rejects other origins, unknown names and bad appearances", () => {
    expect(read({ src: "https://example.com/part.stl", name: "part.stl" })).toBeNull();
    expect(read({ src: `${origin}/a`, name: "notes.txt" })).toBeNull();
    expect(read({ src: `${origin}/a`, name: "part.glb", appearance: "neon" })?.appearance).toBe(
      null,
    );
  });
});
