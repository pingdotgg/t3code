import { expect, it } from "vite-plus/test";

import { readExpandedDirectories, writeExpandedDirectories } from "./fileTreeExpansion";

it("keeps the 100 expanded folders nearest the root, so a remount does not list hundreds", () => {
  const deep = Array.from({ length: 150 }, (_, index) => `pkg/mod/d${index}/`);
  writeExpandedDirectories("env:/repo", [...deep, "pkg/mod/", "pkg/"]);
  const restored = readExpandedDirectories("env:/repo");
  expect(restored).toEqual(["pkg/", "pkg/mod/", ...deep.slice(0, 98)]);
});
