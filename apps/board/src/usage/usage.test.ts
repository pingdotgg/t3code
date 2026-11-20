import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { describeUsage, formatReset, formatWindow, orderWindows, UNAVAILABLE_DASH } from "./usage";

const NOW = Date.parse("2026-11-19T10:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

const window = (
  overrides: Partial<ServerProviderUsageWindow> & Pick<ServerProviderUsageWindow, "id">,
): ServerProviderUsageWindow => ({
  kind: "session",
  label: "Session",
  usedPercent: 0,
  ...overrides,
});

// SAFETY: only the fields the formatter reads are filled in; the formatter touches no others.
const provider = (overrides: Partial<ServerProvider>): ServerProvider =>
  ({
    instanceId: "claudeAgent",
    driver: "claudeAgent",
    displayName: "Claude",
    enabled: true,
    installed: true,
    auth: { status: "authenticated" },
    ...overrides,
  }) as ServerProvider;

describe("formatReset", () => {
  it("Given a reset 40 minutes out, when formatted, then it prints minutes", () => {
    expect(formatReset(at(40 * MINUTE), NOW)).toBe("40m");
  });

  it("Given a reset 5 days 22 hours out, when formatted, then it prints days and hours", () => {
    expect(formatReset(at(5 * DAY + 22 * HOUR + 30 * MINUTE), NOW)).toBe("5d 22h");
  });

  it("Given a reset under a day out, when formatted, then it prints hours and minutes", () => {
    expect(formatReset(at(3 * HOUR + 12 * MINUTE), NOW)).toBe("3h 12m");
  });

  it("Given a reset that already passed, when formatted, then it prints zero minutes", () => {
    expect(formatReset(at(-5 * MINUTE), NOW)).toBe("0m");
  });
});

describe("formatWindow", () => {
  it("Given a session window at 8% resetting in 5 days 22 hours, when formatted, then it reads 8% 5d 22h", () => {
    const segment = formatWindow(
      window({ id: "five_hour", usedPercent: 8.2, resetsAt: at(5 * DAY + 22 * HOUR) }),
      NOW,
    );

    expect(segment.text).toBe("8% 5d 22h");
  });

  it("Given a Fable window at 3%, when formatted, then it reads 3% Fable", () => {
    const segment = formatWindow(
      window({ id: "seven_day_fable", kind: "weekly", label: "Weekly · Fable", usedPercent: 3 }),
      NOW,
    );

    expect(segment.text).toBe("3% Fable");
  });

  it("Given a window with model ids and a plain label, when formatted, then the label names the model", () => {
    const segment = formatWindow(
      window({ id: "spark", label: "Spark", usedPercent: 40, modelIds: ["gpt-5-spark"] }),
      NOW,
    );

    expect(segment.text).toBe("40% Spark");
  });

  it("Given a window without a reset, when formatted, then it prints only the percent", () => {
    expect(formatWindow(window({ id: "w", usedPercent: 49.6 }), NOW).text).toBe("50%");
  });
});

describe("orderWindows", () => {
  it("Given windows in any order, when ordered, then session comes before weekly and model windows last", () => {
    const ordered = orderWindows([
      window({ id: "fable", kind: "weekly", label: "Weekly · Fable" }),
      window({ id: "week", kind: "weekly", label: "Weekly" }),
      window({ id: "session", kind: "session", label: "Session" }),
    ]);

    expect(ordered.map((entry) => entry.id)).toEqual(["session", "week", "fable"]);
  });
});

describe("describeUsage", () => {
  it("Given a Claude provider with limits, when described, then its segments read like the bar", () => {
    const [claude] = describeUsage(
      [
        provider({
          usageLimits: {
            checkedAt: at(0),
            windows: [
              window({
                id: "seven_day_fable",
                kind: "weekly",
                label: "Weekly · Fable",
                usedPercent: 3,
              }),
              window({ id: "five_hour", usedPercent: 8, resetsAt: at(5 * DAY + 22 * HOUR) }),
            ],
          },
        }),
      ],
      NOW,
    );

    expect(claude?.segments.map((segment) => segment.text)).toEqual(["8% 5d 22h", "3% Fable"]);
  });

  it("Given limits marked unavailable, when described, then the dash carries the reason", () => {
    const [codex] = describeUsage(
      [
        provider({
          usageLimits: {
            checkedAt: at(0),
            windows: [],
            unavailable: { reason: "probeFailed", message: "Codex is not signed in." },
          },
        }),
      ],
      NOW,
    );

    expect(codex?.segments).toEqual([
      { key: "unavailable", text: UNAVAILABLE_DASH, title: "Codex is not signed in." },
    ]);
  });

  it("Given a signed-out provider with no limits, when described, then it shows a dash with the reason", () => {
    const [signedOut] = describeUsage(
      [provider({ auth: { status: "unauthenticated" }, message: "Run codex login." })],
      NOW,
    );

    expect(signedOut?.segments).toEqual([
      { key: "signed-out", text: UNAVAILABLE_DASH, title: "Run codex login." },
    ]);
  });

  it("Given a disabled provider and a signed-in one that reports nothing, when described, then neither has a section", () => {
    expect(
      describeUsage([provider({ enabled: false, usageLimits: undefined }), provider({})], NOW),
    ).toEqual([]);
  });

  it("Given Codex listed before Claude, when described, then Claude Code comes first", () => {
    const limits = { checkedAt: at(0), windows: [window({ id: "w", usedPercent: 1 })] };

    const described = describeUsage(
      [
        provider({
          instanceId: ProviderInstanceId.make("codex"),
          driver: ProviderDriverKind.make("codex"),
          usageLimits: limits,
        }),
        provider({ usageLimits: limits }),
      ],
      NOW,
    );

    expect(described.map((entry) => entry.driver)).toEqual(["claudeAgent", "codex"]);
  });
});
