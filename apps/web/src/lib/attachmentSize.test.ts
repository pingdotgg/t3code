import { describe, expect, it } from "vite-plus/test";

import { formatAttachmentSizeLabel } from "./attachmentSize";

describe("formatAttachmentSizeLabel", () => {
  it("formats sub-kilobyte sizes in bytes", () => {
    expect(formatAttachmentSizeLabel(0)).toBe("0 B");
    expect(formatAttachmentSizeLabel(512)).toBe("512 B");
    expect(formatAttachmentSizeLabel(1_023)).toBe("1023 B");
  });

  it("formats kilobyte sizes with one decimal", () => {
    expect(formatAttachmentSizeLabel(1_024)).toBe("1.0 KB");
    expect(formatAttachmentSizeLabel(2_048)).toBe("2.0 KB");
    expect(formatAttachmentSizeLabel(1_024 * 1_024 - 1)).toBe("1024.0 KB");
  });

  it("formats megabyte sizes with one decimal", () => {
    expect(formatAttachmentSizeLabel(1_024 * 1_024)).toBe("1.0 MB");
    expect(formatAttachmentSizeLabel(2_202_010)).toBe("2.1 MB");
  });
});
