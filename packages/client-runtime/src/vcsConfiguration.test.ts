import { describe, expect, it } from "vite-plus/test";
import { gitLargeFileThresholdMib } from "./vcsConfiguration.ts";

describe("Git threshold input in MiB", () => {
  it.each([
    ["1g", "1024"],
    ["512m", "512"],
    ["1048576", "1"],
    ["1536K", "1.5"],
    ["524288", "0.5"],
    ["1", "0.00000095367431640625"],
    [null, ""],
    ["", ""],
    ["invalid", "invalid"],
    ["9007199254740992", "9007199254740992"],
  ])("formats %s as %s without rounding", (raw, expected) => {
    expect(gitLargeFileThresholdMib(raw)).toBe(expected);
  });
});
