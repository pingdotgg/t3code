import { expect, it } from "vite-plus/test";
import { createMessageTimeFormatter } from "./messageTime";

it("honors 24-hour time even for a 12-hour locale, including midnight", () => {
  const format = createMessageTimeFormatter(true, "en-US");
  expect(format(new Date(2026, 0, 1, 15, 7).toISOString())).toBe("15:07");
  expect(format(new Date(2026, 0, 1, 0, 7).toISOString())).toBe("00:07");
});

it("honors 12-hour time even for a 24-hour locale", () => {
  const format = createMessageTimeFormatter(false, "en-GB");
  expect(format(new Date(2026, 0, 1, 15, 7).toISOString())).toMatch(/^3:07 pm$/i);
});

it("uses the locale default without an override and hides invalid timestamps", () => {
  const format = createMessageTimeFormatter(undefined, "en-GB");
  const timestamp = new Date(2026, 0, 1, 15, 7);
  const expected = new Intl.DateTimeFormat("en-GB", {
    hour: "numeric",
    minute: "2-digit",
  }).format(timestamp);
  expect(format(timestamp.toISOString())).toBe(expected);
  expect(format("invalid")).toBe("");
});
