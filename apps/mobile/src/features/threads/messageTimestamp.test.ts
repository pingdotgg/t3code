import { describe, expect, it } from "vite-plus/test";

import { createMessageTimeFormatter, formatMessageTimestamp } from "./messageTimestamp";

describe("formatMessageTimestamp", () => {
  const now = new Date(2026, 10, 8, 20, 0).getTime();
  const time = (date: Date) =>
    date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

  it("shows only the time for today, and the day and month for any earlier day", () => {
    const today = new Date(2026, 10, 8, 0, 5);
    const yesterday = new Date(2026, 10, 7, 23, 55);
    const lastYear = new Date(2025, 10, 5, 19, 17);
    expect(formatMessageTimestamp(today.toISOString(), now)).toBe(time(today));
    expect(formatMessageTimestamp(yesterday.toISOString(), now)).toBe(
      `${yesterday.toLocaleDateString(undefined, { month: "numeric", day: "numeric" })} ${time(yesterday)}`,
    );
    expect(formatMessageTimestamp(lastYear.toISOString(), now)).toBe(
      `${lastYear.toLocaleDateString(undefined, { month: "numeric", day: "numeric", year: "numeric" })} ${time(lastYear)}`,
    );
  });
});

describe("createMessageTimeFormatter", () => {
  const now = new Date(2026, 0, 1, 20, 0).getTime();

  it("follows the system clock preference over the locale's hour cycle", () => {
    const format24 = createMessageTimeFormatter(true, "en-US");
    expect(format24(new Date(2026, 0, 1, 15, 7).toISOString(), now)).toBe("15:07");
    expect(format24(new Date(2026, 0, 1, 0, 7).toISOString(), now)).toBe("00:07");
    const format12 = createMessageTimeFormatter(false, "en-GB");
    expect(format12(new Date(2026, 0, 1, 15, 7).toISOString(), now)).toMatch(/^3:07\spm$/i);
  });
});
