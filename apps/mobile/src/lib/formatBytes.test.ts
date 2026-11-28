import { describe, expect, it } from "vite-plus/test";

import { formatBytes } from "./formatBytes";

describe("formatBytes", () => {
  it.each([
    [1_023, "1023 B"],
    [1_047_552, "1023 KB"],
    [1_048_575, "1.0 MB"],
    [1_073_741_823, "1.0 GB"],
    [24 * 1024 ** 3, "24.0 GB"],
  ])("formats %d bytes as %s", (bytes, label) => {
    expect(formatBytes(bytes)).toBe(label);
  });
});
