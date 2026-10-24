import { expect, it } from "vite-plus/test";

import { isCompactCommandText } from "./composerDispatch.ts";

it("recognizes explicit compaction commands, with or without instructions", () => {
  expect(isCompactCommandText("/compact")).toBe(true);
  expect(isCompactCommandText("  /COMPACT  ")).toBe(true);
  expect(isCompactCommandText("/compact keep the debugging notes")).toBe(true);
  expect(isCompactCommandText("/compactify")).toBe(false);
  expect(isCompactCommandText("please /compact")).toBe(false);
  expect(isCompactCommandText("Also end your reply with PINEAPPLE.")).toBe(false);
});
