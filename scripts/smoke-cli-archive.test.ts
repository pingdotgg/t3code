import { expect, it } from "vite-plus/test";

import { isCliPageResponse } from "./smoke-cli-archive.ts";

it("accepts the shipped page without requiring optional HTML tags", () => {
  const page = '<!doctype html><title>T3 Code</title><div id="root"></div>';
  expect(isCliPageResponse(200, "text/html; charset=utf-8", page, page)).toBe(true);
  expect(isCliPageResponse(503, "text/html", page, page)).toBe(false);
  expect(isCliPageResponse(200, "application/json", page, page)).toBe(false);
  expect(isCliPageResponse(200, "text/html", "different service", page)).toBe(false);
  expect(isCliPageResponse(200, "text/html", "", "")).toBe(false);
});
