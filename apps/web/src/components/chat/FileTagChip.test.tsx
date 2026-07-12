import { describe, expect, it } from "vite-plus/test";

import { inferFileTagEntryKind } from "./FileTagChip";

describe("inferFileTagEntryKind", () => {
  it("renders extensionless generated attachments as files", () => {
    expect(
      inferFileTagEntryKind(
        "/Users/test/.t3/attachments/12345678-1234-1234-1234-123456789abc/extensionless-test",
      ),
    ).toBe("file");
  });

  it("preserves directory inference for ordinary extensionless paths", () => {
    expect(inferFileTagEntryKind("packages/client-runtime")).toBe("directory");
  });
});
