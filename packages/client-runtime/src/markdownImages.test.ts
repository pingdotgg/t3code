import { describe, expect, it } from "vite-plus/test";

import { classifyMarkdownImageSource } from "./markdownImages.js";

describe("classifyMarkdownImageSource", () => {
  it.each([
    ["images/result.png", "/workspace/project", "/workspace/project/images/result.png"],
    [
      "images\\result.png",
      "C:\\Users\\dara\\project",
      "C:\\Users\\dara\\project\\images\\result.png",
    ],
    ["file:///workspace/project/image%20one.png", null, "/workspace/project/image one.png"],
    ["file://server/share/image.png", "\\\\server\\share", "\\\\server\\share\\image.png"],
  ])("maps %s to a workspace file", (source, workspaceRoot, path) => {
    expect(classifyMarkdownImageSource(source, workspaceRoot)).toEqual({
      _tag: "WorkspaceFile",
      path,
      ...(source.startsWith("file:") ? {} : { relative: true }),
    });
  });

  // Amp uploads local images to auth-only URLs and keeps the original file in the fragment.
  it("maps an Amp attachment URL to its amp-media-source file", () => {
    const source =
      "https://ampcode.com/user-content/attachments/3f9c2a1b7e-1-shot.png" +
      "#amp-media-source=file%3A%2F%2F%2Fworkspace%2Fproject%2F.amp%2Fin%2Fartifacts%2F1-shot.png";
    expect(classifyMarkdownImageSource(source, "/workspace/project")).toEqual({
      _tag: "WorkspaceFile",
      path: "/workspace/project/.amp/in/artifacts/1-shot.png",
    });
  });

  it.each(["image.png", "javascript:alert(1)", "file://%"])(
    "blocks unsupported or unresolved source %s",
    (source) => {
      expect(classifyMarkdownImageSource(source)).toEqual({ _tag: "Blocked" });
    },
  );

  // Loading these makes Windows send the user's NTLM credentials to the named host.
  it.each([
    "file://attacker.test/share/cat.jpg",
    "\\\\attacker.test\\share\\cat.jpg",
    "/\\attacker.test\\share\\cat.jpg",
    "file:/%5Cattacker.test%5Cshare%5Ccat.jpg",
    "\\\\server\\other\\cat.jpg",
  ])("blocks network path %s outside the project", (source) => {
    expect(classifyMarkdownImageSource(source, "\\\\server\\share\\project")).toEqual({
      _tag: "Blocked",
    });
  });
});
