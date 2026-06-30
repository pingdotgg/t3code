import { describe, expect, it } from "vite-plus/test";

import { countNeedsAttention, ticketAging } from "./agingFormat.ts";

const NOW = Date.parse("2026-06-10T12:00:00.000Z");
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60 * 1000).toISOString();

describe("ticketAging", () => {
  it("ignores healthy and fresh tickets", () => {
    expect(ticketAging({ status: "running", updatedAt: minutesAgo(600) }, NOW)).toBeNull();
    expect(ticketAging({ status: "waiting_on_user", updatedAt: minutesAgo(5) }, NOW)).toBeNull();
    expect(ticketAging({ status: "waiting_on_user" }, NOW)).toBeNull();
  });

  it("warns after 30 minutes and alerts after 2 hours", () => {
    const warn = ticketAging({ status: "waiting_on_user", updatedAt: minutesAgo(45) }, NOW);
    expect(warn?.level).toBe("warn");
    expect(warn?.label).toContain("needs you");

    const alert = ticketAging({ status: "blocked", updatedAt: minutesAgo(180) }, NOW);
    expect(alert?.level).toBe("alert");
    expect(alert?.label).toContain("blocked");
  });

  it("counts tickets needing attention", () => {
    expect(
      countNeedsAttention(
        [
          { status: "waiting_on_user", updatedAt: minutesAgo(45) },
          { status: "running", updatedAt: minutesAgo(45) },
          { status: "blocked", updatedAt: minutesAgo(200) },
        ],
        NOW,
      ),
    ).toBe(2);
  });
});
