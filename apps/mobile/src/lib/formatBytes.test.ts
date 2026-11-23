import { describe, expect, it } from "vite-plus/test";

import { formatBytes } from "./formatBytes";

describe("formatBytes", () => {
  it.each([
    [0, "0 B"],
    [1_023, "1023 B"],
    [1_024, "1.0 KB"],
    [1_047_552, "1023 KB"],
    [1_048_575, "1.0 MB"],
    [1_073_741_823, "1.0 GB"],
    [10_230, "10 KB"],
    [1024 ** 4, "1.0 TB"],
  ])("formats %d bytes as %s from the rounded value", (bytes, label) => {
    expect(formatBytes(bytes)).toBe(label);
  });
});
