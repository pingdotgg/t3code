import { describe, expect, it } from "vite-plus/test";

import { formatBytes } from "./format-bytes";

describe("formatBytes", () => {
  it.each([
    [1_048_575, "1.0 MB"],
    [1_073_741_823, "1.0 GB"],
  ])("formats %d bytes as %s once rounding reaches the next unit", (bytes, label) => {
    expect(formatBytes(bytes)).toBe(label);
  });
});
