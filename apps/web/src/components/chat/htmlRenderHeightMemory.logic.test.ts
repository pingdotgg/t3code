import { expect, it } from "vite-plus/test";

import { createMemoryStorage } from "~/lib/storage";

import { createHtmlRenderHeightMemory, rememberedHtmlRenderHeight } from "./htmlRenderHeightMemory";

it("keeps a render's reported heights by width across a reload", () => {
  const storage = createMemoryStorage();
  const before = createHtmlRenderHeightMemory(storage);
  before.remember("page", 728, 6034);
  before.remember("page", 640.4, 6623);
  before.remember("page", 728, 6108);
  before.flush();

  const after = createHtmlRenderHeightMemory(storage).get("page");
  expect(rememberedHtmlRenderHeight(after, 728)).toBe(6108);
  expect(rememberedHtmlRenderHeight(after, 640)).toBe(6623);
  expect(rememberedHtmlRenderHeight(after, 700)).toBeUndefined();
});

it("starts empty when the stored heights are unreadable", () => {
  const storage = createMemoryStorage();
  storage.setItem("t3code:html-render-heights:v1", '{"page":728}');

  expect(createHtmlRenderHeightMemory(storage).get("page")).toEqual([]);
});
