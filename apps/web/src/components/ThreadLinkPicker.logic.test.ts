import { expect, it } from "vite-plus/test";

import { threadLinkMatcher } from "./ThreadLinkPicker.logic";

it.each([
  ["cafe", "Café planning", undefined],
  ["café", "Café planning", undefined],
  ["ışık", "Işık planı", "tr-TR"],
])("matches %s against %s", (query, text, locale) => {
  expect(threadLinkMatcher(query, locale)(text)).toBe(true);
});
