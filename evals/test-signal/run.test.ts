import { describe, expect, it } from "vite-plus/test";
import { grade, testRange } from "./grade.ts";

const source = [
  'describe("x", () => {',
  '  it("first", () => {',
  "    expect(1).toBe(1);",
  "  });",
  "",
  '  it("second", () => {});',
  "});",
].join("\n");

describe("grade", () => {
  const target = { path: "a.test.ts", ...testRange(source, "first")! };
  const comment = (line: number) => ({ path: "a.test.ts", line, body: "fold it" });

  it.each([
    ["bad, comment inside the target", "bad", [comment(3)], "", true],
    ["bad, comment on the next test", "bad", [comment(6)], "", false],
    ["guard, nothing posted", "guard", [], "All clear", true],
    ["guard, nothing posted but extra text", "guard", [], "All clear. Nice tests.", false],
    ["guard, a comment", "guard", [comment(3)], "All clear", false],
  ] as const)("%s", (_name, kind, comments, final, pass) => {
    expect(grade({ kind, targets: [target], comments, final }).pass).toBe(pass);
  });
});
