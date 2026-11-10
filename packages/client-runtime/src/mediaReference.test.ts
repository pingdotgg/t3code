import { describe, expect, it } from "vite-plus/test";

import { mediaFileReference, mediaReferenceFileName } from "./mediaReference.ts";

describe("mediaFileReference", () => {
  it.each([
    ["/work/project/./media/../clip.mp4", "/work/project/", "clip.mp4"],
    ["/work/project-other/clip.mp4", "/work/project", undefined],
    ["C:\\WORK\\project\\media\\..\\Clip.mp4", "c:/work/project/", "Clip.mp4"],
    ["\\\\Server\\Share\\Project\\Clip.mp4", "//server/share/project", "Clip.mp4"],
  ])("preserves %s and only labels paths inside %s as relative", (path, root, relativePath) => {
    expect(mediaFileReference(path, root)).toEqual({
      kind: "file",
      path,
      ...(relativePath === undefined ? {} : { relativePath }),
    });
  });
});

describe("mediaReferenceFileName", () => {
  it.each([
    [{ kind: "file", path: "/tmp/take\\one%20.mp4" }, "take\\one%20.mp4"],
    [{ kind: "url", url: "//cdn.example/clip%20one%2Emp4?sig=a+b#t=2" }, "clip one.mp4"],
    [{ kind: "url", url: "https://cdn.example/clip%20%oops.mp4" }, "clip%20%oops.mp4"],
  ] as const)("preserves filename semantics for %j", (reference, name) => {
    expect(mediaReferenceFileName(reference)).toBe(name);
  });
});
