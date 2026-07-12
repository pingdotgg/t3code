import { describe, expect, it } from "vite-plus/test";

import { removedOwnedTextAttachmentPaths, textAttachmentPaths } from "./textAttachmentPaths";

describe("textAttachmentPaths", () => {
  it("collects unique generated attachment links from a discarded draft", () => {
    const path = "/var/t3-data/attachments/text/12345678-1234-1234-1234-123456789abc/notes.txt";

    expect(textAttachmentPaths(`[notes.txt](${path}) keep [notes.txt](${path})`)).toEqual([path]);
    expect(textAttachmentPaths("ordinary prompt")).toEqual([]);
  });
});

describe("removedOwnedTextAttachmentPaths", () => {
  it("collects an owned attachment after its generated link is removed", () => {
    const ownedPath =
      "/var/t3-data/attachments/text/12345678-1234-1234-1234-123456789abc/notes.txt";
    const unrelatedPath =
      "/var/t3-data/attachments/text/87654321-4321-4321-4321-cba987654321/copied.txt";

    expect(
      removedOwnedTextAttachmentPaths(
        `[notes.txt](${ownedPath}) [copied.txt](${unrelatedPath})`,
        `[copied.txt](${unrelatedPath})`,
        new Set([ownedPath]),
      ),
    ).toEqual([ownedPath]);
  });

  it("keeps an owned attachment while its link remains", () => {
    const path = "/var/t3-data/attachments/text/12345678-1234-1234-1234-123456789abc/notes.txt";

    expect(
      removedOwnedTextAttachmentPaths(`[notes.txt](${path})`, `[notes](${path})`, new Set([path])),
    ).toEqual([]);
  });
});
