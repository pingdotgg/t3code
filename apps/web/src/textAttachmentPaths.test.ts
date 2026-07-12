import { describe, expect, it } from "vite-plus/test";

import {
  removedTextAttachmentPaths,
  textAttachmentPaths,
  unreferencedTextAttachmentPaths,
} from "./textAttachmentPaths";

describe("textAttachmentPaths", () => {
  it("collects unique generated attachment links from a discarded draft", () => {
    const path = "/var/t3-data/attachments/text/12345678-1234-1234-1234-123456789abc/notes.txt";

    expect(textAttachmentPaths(`[notes.txt](${path}) keep [notes.txt](${path})`)).toEqual([path]);
    expect(textAttachmentPaths("ordinary prompt")).toEqual([]);
  });

  it("collects a generated attachment whose Markdown link ends at EOF", () => {
    const path = "/var/t3-data/attachments/text/12345678-1234-1234-1234-123456789abc/notes.txt";

    expect(textAttachmentPaths(`[notes.txt](${path})`)).toEqual([path]);
  });
});

describe("removedTextAttachmentPaths", () => {
  it("collects a generated attachment after its link is removed", () => {
    const removedPath =
      "/var/t3-data/attachments/text/12345678-1234-1234-1234-123456789abc/notes.txt";
    const retainedPath =
      "/var/t3-data/attachments/text/87654321-4321-4321-4321-cba987654321/copied.txt";

    expect(
      removedTextAttachmentPaths(
        `[notes.txt](${removedPath}) [copied.txt](${retainedPath})`,
        `[copied.txt](${retainedPath})`,
      ),
    ).toEqual([removedPath]);
  });

  it("keeps a copied attachment while its link remains", () => {
    const path = "/var/t3-data/attachments/text/12345678-1234-1234-1234-123456789abc/notes.txt";

    expect(removedTextAttachmentPaths(`[notes.txt](${path})`, `[notes](${path})`)).toEqual([]);
  });

  it("detects EOF removal after ownership state is lost on remount", () => {
    const path = "/var/t3-data/attachments/text/12345678-1234-1234-1234-123456789abc/notes.txt";

    expect(removedTextAttachmentPaths(`[notes.txt](${path})`, "")).toEqual([path]);
  });

  it("preserves an attachment whose next link ends at EOF", () => {
    const path = "/var/t3-data/attachments/text/12345678-1234-1234-1234-123456789abc/notes.txt";

    expect(removedTextAttachmentPaths(`[notes.txt](${path}) `, `[notes.txt](${path})`)).toEqual([]);
  });
});

describe("unreferencedTextAttachmentPaths", () => {
  it("protects an attachment referenced by another unsent draft", () => {
    const sharedPath =
      "/var/t3-data/attachments/text/12345678-1234-1234-1234-123456789abc/shared.txt";
    const uniquePath =
      "/var/t3-data/attachments/text/87654321-4321-4321-4321-cba987654321/unique.txt";

    expect(
      unreferencedTextAttachmentPaths(
        [`[shared.txt](${sharedPath}) [unique.txt](${uniquePath}) `],
        [`Still using [shared.txt](${sharedPath}) `],
      ),
    ).toEqual([uniquePath]);
  });
});
