import { describe, expect, it } from "vite-plus/test";

import { classifyDroppedFile, formatInlinedTextFile, fileExtension } from "./composerDroppedFiles";

const classify = (name: string, type: string, isHeicImage = false) =>
  classifyDroppedFile({ name, type }, { isHeicImage });

describe("classifyDroppedFile", () => {
  it("keeps image drops on the image path", () => {
    expect(classify("shot.png", "image/png")).toBe("image");
    expect(classify("photo.heic", "", true)).toBe("image");
  });

  it("treats PDFs as documents", () => {
    expect(classify("spec.pdf", "application/pdf")).toBe("document");
  });

  it("treats a PDF with no mime type as a document", () => {
    // Some apps hand over a dragged PDF without a mime type.
    expect(classify("spec.pdf", "")).toBe("document");
  });

  it("treats text and markdown as inlineable text", () => {
    expect(classify("notes.txt", "text/plain")).toBe("text");
    expect(classify("README.md", "")).toBe("text");
    expect(classify("post.mdx", "")).toBe("text");
  });

  it("rejects everything else", () => {
    expect(classify("archive.zip", "application/zip")).toBe("unsupported");
    expect(classify("bin", "")).toBe("unsupported");
  });

  it("is case insensitive on extension and mime type", () => {
    expect(classify("SPEC.PDF", "APPLICATION/PDF")).toBe("document");
    expect(classify("NOTES.MD", "")).toBe("text");
  });
});

describe("fileExtension", () => {
  it("returns a lowercased extension or an empty string", () => {
    expect(fileExtension("a/b/File.MD")).toBe(".md");
    expect(fileExtension("noextension")).toBe("");
  });
});

describe("formatInlinedTextFile", () => {
  it("fences the contents under the file name", () => {
    expect(formatInlinedTextFile({ name: "notes.txt", contents: "hello" })).toBe(
      "notes.txt:\n```\nhello\n```",
    );
  });

  it("grows the fence past any backtick run in the file", () => {
    // A markdown file containing a fenced block must not close its own fence.
    const contents = "before\n```js\ncode\n```\nafter";
    const formatted = formatInlinedTextFile({ name: "post.md", contents });
    expect(formatted.startsWith("post.md:\n````\n")).toBe(true);
    expect(formatted.endsWith("\n````")).toBe(true);
    expect(formatted).toContain("```js");
  });

  it("trims trailing whitespace so the closing fence stays on its own line", () => {
    expect(formatInlinedTextFile({ name: "a.txt", contents: "body\n\n" })).toBe(
      "a.txt:\n```\nbody\n```",
    );
  });
});
