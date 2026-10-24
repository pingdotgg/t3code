import type { FileDiffMetadata } from "@pierre/diffs";
import { preloadFileTree } from "@pierre/trees";
import { describe, expect, it } from "vite-plus/test";
import { orderDiffFiles } from "./pullRequestFileOrder.logic";
import { compareDiffFileTreeEntries, diffFileTreePositions } from "../diffs/diffFileTree.logic";
function file(name: string): FileDiffMetadata {
  return { name, type: "change" } as FileDiffMetadata;
}
describe("review reading order", () => {
  it("matches the expanded tree, with alphabetical siblings in every subtree", () => {
    const files = ["src/z.ts", "src/utils/z.ts", "README.md", "src/utils/a.ts", "src/a.ts"].map(
      file,
    );
    const paths = orderDiffFiles(files).map((file) => file.name);
    const positions = diffFileTreePositions(paths);
    const tree = preloadFileTree({
      paths,
      initialExpansion: "open",
      sort: compareDiffFileTreeEntries(() => positions),
    });
    const rows = [...tree.shadowHtml.matchAll(/data-item-path="([^"]+)"/g)]
      .map((match) => match[1])
      .filter((path) => paths.includes(path!));
    expect(paths).toEqual([
      "src/utils/a.ts",
      "src/utils/z.ts",
      "src/a.ts",
      "src/z.ts",
      "README.md",
    ]);
    expect(rows).toEqual(paths);
  });
  it("keeps both halves of a file type change", () => {
    expect(
      orderDiffFiles([
        { ...file("link"), type: "deleted" },
        { ...file("link"), type: "new" },
      ]),
    ).toHaveLength(2);
  });
  it("groups code, tests and generated files only when requested", () => {
    const files = ["src/z.test.ts", "src/__generated__/a.ts", "src/a.ts"].map(file);
    expect(orderDiffFiles(files, true).map((file) => file.name)).toEqual([
      "src/a.ts",
      "src/z.test.ts",
      "src/__generated__/a.ts",
    ]);
  });

  it("pairs a test with the source whose name carries its own dotted suffix", () => {
    expect(
      order([
        file("src/c.browser.test.tsx"),
        file("src/b.test.ts"),
        file("src/a.logic.test.ts"),
        file("src/c.tsx"),
        file("src/b.ts"),
        file("src/a.logic.ts"),
      ]),
    ).toEqual([
      "src/a.logic.ts",
      "src/b.ts",
      "src/c.tsx",
      "src/a.logic.test.ts",
      "src/b.test.ts",
      "src/c.browser.test.tsx",
    ]);
  });
});
