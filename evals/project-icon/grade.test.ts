import { describe, expect, it } from "vite-plus/test";
import { gradeProjectIcon } from "./grade.ts";

describe("gradeProjectIcon", () => {
  it("accepts a lowercase hyphenated name with a known color", () => {
    expect(gradeProjectIcon({ name: "folder-code", color: "blue" })).toBe(true);
  });

  it("rejects invented names, bad casing, and unknown colors", () => {
    expect(gradeProjectIcon({ name: "Not A Real Icon!", color: "blue" })).toBe(false);
    expect(gradeProjectIcon({ name: "folder-code", color: "chartreuse" })).toBe(false);
  });
});
