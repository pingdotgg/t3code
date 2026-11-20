import { expect, it } from "vite-plus/test";

import { threadLinkMatcher } from "./ThreadLinkPicker.logic";

it("finds a thread by Turkish case-insensitive spelling", () => {
  expect(threadLinkMatcher("ışık", "tr-TR")("Işık planı")).toBe(true);
});
