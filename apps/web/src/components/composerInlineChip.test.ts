import { describe, expect, it } from "vite-plus/test";

import { middleTruncateAttachmentName } from "./composerInlineChip";

describe("middleTruncateAttachmentName", () => {
  it("leaves short names unchanged", () => {
    expect(middleTruncateAttachmentName("notes.txt")).toBe("notes.txt");
  });

  it("keeps the start and filename extension", () => {
    const result = middleTruncateAttachmentName(
      "a-very-long-customer-reproduction-screenshot.final.png",
    );
    expect(result).toHaveLength(36);
    expect(result).toMatch(/^a-very-long-customer/);
    expect(result).toMatch(/final\.png$/);
    expect(result).toContain("…");
  });

  it("truncates Unicode names without splitting a character", () => {
    expect(middleTruncateAttachmentName("😀😀😀😀😀😀.png", 8)).toBe("😀😀😀….png");
  });

  it("honours very small limits", () => {
    expect(middleTruncateAttachmentName("notes.txt", 0)).toBe("");
    expect(middleTruncateAttachmentName("notes.txt", 1)).toBe("…");
    expect(middleTruncateAttachmentName("notes.txt", 2)).toBe("n…");
  });

  it("keeps useful ends for multi-dot names and names without extensions", () => {
    expect(middleTruncateAttachmentName("customer.export.final.very-long-name.json", 24)).toMatch(
      /long-name\.json$/,
    );
    expect(middleTruncateAttachmentName("a-very-long-filename-without-an-extension", 20)).toMatch(
      /^a-ver.*extension$/,
    );
  });
});
