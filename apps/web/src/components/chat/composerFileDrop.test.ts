import { describe, expect, it } from "@effect/vitest";

import {
  buildDroppedFileMentions,
  partitionDroppedComposerFiles,
  toComposerMentionPath,
} from "./composerFileDrop.ts";

const fakeFile = (type: string, name: string): File => ({ type, name }) as unknown as File;

describe("partitionDroppedComposerFiles", () => {
  it("splits image files from everything else, preserving order", () => {
    const png = fakeFile("image/png", "shot.png");
    const doc = fakeFile("text/markdown", "notes.md");
    const jpeg = fakeFile("image/jpeg", "photo.jpg");
    const bin = fakeFile("", "Makefile");

    const { imageFiles, pathFiles } = partitionDroppedComposerFiles([png, doc, jpeg, bin]);

    expect(imageFiles).toEqual([png, jpeg]);
    expect(pathFiles).toEqual([doc, bin]);
  });

  it("returns empty partitions for no files", () => {
    expect(partitionDroppedComposerFiles([])).toEqual({ imageFiles: [], pathFiles: [] });
  });
});

describe("toComposerMentionPath", () => {
  it("relativises a path inside the workspace cwd", () => {
    expect(toComposerMentionPath("/home/me/proj/src/app.ts", "/home/me/proj")).toBe("src/app.ts");
  });

  it("tolerates a trailing slash on the cwd", () => {
    expect(toComposerMentionPath("/home/me/proj/src/app.ts", "/home/me/proj/")).toBe("src/app.ts");
  });

  it("keeps the absolute path when it is outside the cwd", () => {
    expect(toComposerMentionPath("/etc/hosts", "/home/me/proj")).toBe("/etc/hosts");
  });

  it("keeps the absolute path when there is no cwd", () => {
    expect(toComposerMentionPath("/home/me/proj/src/app.ts", null)).toBe("/home/me/proj/src/app.ts");
  });

  it("does not relativise the cwd itself to an empty string", () => {
    expect(toComposerMentionPath("/home/me/proj", "/home/me/proj")).toBe("/home/me/proj");
  });

  it("normalises Windows separators and relativises", () => {
    expect(toComposerMentionPath("C:\\Users\\me\\proj\\src\\app.ts", "C:\\Users\\me\\proj")).toBe(
      "src/app.ts",
    );
  });
});

describe("buildDroppedFileMentions", () => {
  it("serializes each path as a space-separated file link", () => {
    expect(
      buildDroppedFileMentions(["/home/me/proj/src/app.ts", "/etc/hosts"], "/home/me/proj"),
    ).toBe("[app.ts](src/app.ts) [hosts](/etc/hosts)");
  });

  it("returns an empty string for no paths", () => {
    expect(buildDroppedFileMentions([], "/home/me/proj")).toBe("");
  });
});
