import { describe, expect, it } from "vite-plus/test";

import { formatWorkspaceRelativePath } from "./filePathDisplay";

describe("formatWorkspaceRelativePath", () => {
  it("keeps a Windows drive path outside the workspace absolute", () => {
    const workspaceRoot = String.raw`C:\work\pv-assets`;
    const paths = [String.raw`C:\tmp\bc2.png:12`, "D:/tmp/image.png", "/C:/tmp/image.png"];

    expect(paths.map((path) => formatWorkspaceRelativePath(path, workspaceRoot))).toEqual([
      "C:/tmp/bc2.png:12",
      "D:/tmp/image.png",
      "C:/tmp/image.png",
    ]);
  });
});
