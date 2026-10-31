import { describe, expect, it } from "vite-plus/test";

import { formatBytes } from "./formatBytes";

describe("formatBytes", () => {
  it.each([
    [0, "0 B"],
    [1_023, "1023 B"],
    [1_024, "1.00 KB"],
    [1_536, "1.50 KB"],
    [1_047_552, "1023 KB"],
    [1_048_576, "1.00 MB"],
    [5 * 1_024 ** 4, "5.00 TB"],
    [2_048 * 1_024 ** 4, "2048 TB"],
  ])("formats %d bytes as %s", (value, label) => {
    expect(formatBytes(value)).toBe(label);
  });

  it.each([
    [1_023.6, "1.00 KB"],
    [1_048_100, "1.00 MB"],
    [1_073_217_536, "1.00 GB"],
  ])("moves %d bytes to the next unit when rounding reaches 1024", (value, label) => {
    expect(formatBytes(value)).toBe(label);
  });
});
