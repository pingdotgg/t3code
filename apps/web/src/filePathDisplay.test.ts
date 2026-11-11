import { describe, expect, it } from "vite-plus/test";

import { formatWorkspaceRelativePath } from "./filePathDisplay";

describe("formatWorkspaceRelativePath", () => {
  // regression: #27308 a drive path outside the workspace is not a relative path
  it("keeps an external Windows path absolute and uses slashes", () => {
    expect(formatWorkspaceRelativePath("C:/tmp/image.png", "C:/work/project")).toBe(
      "C:/tmp/image.png",
    );
    expect(formatWorkspaceRelativePath("C:\\tmp\\image.png", "C:\\work\\project")).toBe(
      "C:/tmp/image.png",
    );
    expect(formatWorkspaceRelativePath("D:/tmp/image.png", "C:/work/project")).toBe(
      "D:/tmp/image.png",
    );
  });

  it("shows a file inside the workspace relative to the project folder", () => {
    expect(formatWorkspaceRelativePath("C:/work/project/inside.png", "C:/work/project")).toBe(
      "project/inside.png",
    );
  });
});
