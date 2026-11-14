import { describe, expect, it } from "vite-plus/test";

import { formatBytes } from "./formatBytes";

describe("formatBytes", () => {
  it.each([
    [1_048_575, "1.0 MB"],
    [1_073_741_823, "1.0 GB"],
    [10_230, "10 KB"],
  ])("formats %d bytes as %s from the rounded value", (bytes, label) => {
    expect(formatBytes(bytes)).toBe(label);
  });
});
