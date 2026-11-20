import { RunId } from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("gt-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("gt-react")>()),
  useGT:
    () =>
    (text: string, values: Record<string, unknown> = {}) =>
      text.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key])),
  T: ({ children }: { children: ReactNode }) => children,
}));

import { usageLimitRecoveryBannerItem } from "./UsageLimitRecoveryBanner";

const stoppedAt = new Date(2026, 9, 20, 12, 0);

function bannerItem(resetAt: Date, timestampFormat: TimestampFormat = "24-hour") {
  return usageLimitRecoveryBannerItem({
    runId: RunId.make("run-1"),
    errorCode: null,
    resetAt: resetAt.toISOString(),
    stoppedAt: stoppedAt.toISOString(),
    settled: false,
    requestPending: false,
    snoozedUntil: null,
    recovery: null,
    timestampFormat,
    onChange: async () => {},
  });
}

function bannerDescription(resetAt: Date, timestampFormat: TimestampFormat) {
  return bannerItem(resetAt, timestampFormat).description;
}

describe("usageLimitRecoveryBannerItem", () => {
  it.each([
    ["12-hour", "Resets 5:30 PM"],
    ["24-hour", "Resets 17:30"],
  ] as const)("formats a same-day reset with the %s setting", (timestampFormat, expected) => {
    using _now = vi.spyOn(Date, "now").mockReturnValue(stoppedAt.getTime());
    expect(bannerDescription(new Date(2026, 9, 20, 17, 30), timestampFormat)).toBe(expected);
  });

  it("names the day when the reset is tomorrow", () => {
    using _now = vi.spyOn(Date, "now").mockReturnValue(stoppedAt.getTime());
    expect(bannerDescription(new Date(2026, 9, 21, 17, 30), "24-hour")).toBe(
      "Resets tomorrow at 17:30",
    );
  });

  it("uses past-tense copy and Resume now after the reset time has passed", () => {
    const resetAt = new Date(2026, 9, 20, 15, 0);
    {
      using _before = vi
        .spyOn(Date, "now")
        .mockReturnValue(new Date(2026, 9, 20, 14, 57).getTime());
      const before = bannerItem(resetAt, "24-hour");
      expect(before.description).toBe("Resets 15:00");
      const beforeHtml = renderToStaticMarkup(before.actions);
      expect(beforeHtml).toContain("Resume at reset");
      expect(beforeHtml).not.toContain('disabled=""');
    }
    {
      using _after = vi.spyOn(Date, "now").mockReturnValue(new Date(2026, 9, 20, 15, 14).getTime());
      const after = bannerItem(resetAt, "24-hour");
      expect(after.description).toBe("Reset 15:00");
      const afterHtml = renderToStaticMarkup(after.actions);
      expect(afterHtml).toContain("Resume now");
      expect(afterHtml).not.toContain("Resume at reset");
      expect(afterHtml).toMatch(/disabled=""[^>]*>Snooze until reset/);
    }
  });

  it("keeps Resumes copy until a later snooze wake time, then falls back to Reset", () => {
    const resetAt = new Date(2026, 9, 20, 15, 0);
    const snoozedUntil = new Date(2026, 9, 20, 16, 0);
    const runId = RunId.make("run-1");
    const makeScheduled = () =>
      usageLimitRecoveryBannerItem({
        runId,
        errorCode: null,
        resetAt: resetAt.toISOString(),
        stoppedAt: stoppedAt.toISOString(),
        settled: false,
        requestPending: false,
        snoozedUntil: snoozedUntil.toISOString(),
        recovery: {
          runId,
          resetAt: resetAt.toISOString(),
          autoResume: true,
        },
        timestampFormat: "24-hour",
        onChange: async () => {},
      });
    {
      using _between = vi
        .spyOn(Date, "now")
        .mockReturnValue(new Date(2026, 9, 20, 15, 14).getTime());
      expect(makeScheduled().description).toBe("Resumes 16:00");
    }
    {
      using _afterSnooze = vi
        .spyOn(Date, "now")
        .mockReturnValue(new Date(2026, 9, 20, 16, 5).getTime());
      expect(makeScheduled().description).toBe("Reset 15:00");
    }
  });
});
