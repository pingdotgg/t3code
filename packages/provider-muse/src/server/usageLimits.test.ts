import { describe, expect, it } from "@effect/vitest";

import {
  isMuseUsageLimitFailure,
  museStatusUsageLimits,
  museUsageAccount,
  museUsageLimitResetAt,
  museUsageLimits,
  museUsageObservationFromHubSignals,
  museUsageWindows,
  nextMuseUsageAccount,
} from "./usageLimits.ts";

// What Meta reported after a reply on 2026-10-08, as Muse forwards it.
const observation = {
  observedAtMs: 1791447762610,
  window: { usedPercent: 0, windowDurationMins: 300, resetsAtMs: 1791465557000 },
  weekly: { usedPercent: 5, resetsAtMs: 1791763200000 },
};
const reported = observation.observedAtMs;

describe("Muse usage limits", () => {
  it("maps Meta's window and week onto session and weekly rows", () => {
    expect(museUsageWindows(observation, reported)).toEqual([
      {
        id: "window",
        kind: "session",
        label: "Session",
        windowDurationMins: 300,
        usedPercent: 0,
        resetsAt: "2026-10-08T13:19:17.000Z",
      },
      {
        id: "weekly",
        kind: "weekly",
        label: "Weekly",
        windowDurationMins: 10080,
        usedPercent: 5,
        resetsAt: "2026-10-12T00:00:00.000Z",
      },
    ]);
    // Dated by the report, so the freshest report wins across environments.
    expect(museUsageLimits(observation, reported).checkedAt).toBe("2026-10-08T08:22:42.610Z");
  });

  it("caps over-quota percentages and starts a reset window over empty", () => {
    const windows = museUsageWindows(
      {
        ...observation,
        window: { ...observation.window, usedPercent: 104 },
        weekly: { ...observation.weekly, usedPercent: 101 },
      },
      observation.window.resetsAtMs + 60_000,
    );
    // The session window has reset since the report; Meta opens the next one on use.
    expect(windows[0]).toEqual({
      id: "window",
      kind: "session",
      label: "Session",
      windowDurationMins: 300,
      usedPercent: 0,
    });
    expect(windows[1]).toMatchObject({ id: "weekly", usedPercent: 100 });
  });

  it("publishes a login's report, waits for one, and leaves API keys to the hub", () => {
    const login = {
      status: "authenticated",
      type: "accountLogin",
      email: "a@example.com",
    } as const;
    const status = (
      auth: Parameters<typeof museStatusUsageLimits>[0]["auth"],
      withReport: boolean,
      enabled = true,
    ) =>
      museStatusUsageLimits({
        auth,
        enabled,
        observation: withReport ? observation : undefined,
        nowMs: reported,
      });

    expect(status(login, true)).toEqual(museUsageLimits(observation, reported));
    expect(status(login, false)?.unavailable).toEqual({
      reason: "probeFailed",
      message: "Muse reports usage limits with its next reply.",
    });
    // A hub key would draw the hub's account a second time, with no name to merge it by.
    const hubKey = { status: "authenticated", type: "apiKey", label: "API key" } as const;
    expect(status(hubKey, true)?.unavailable?.reason).toBe("unsupported");
    // Without account/read the lane is unknown: show what Muse reports, but promise nothing.
    expect(status({ status: "unknown" }, true)).toEqual(museUsageLimits(observation, reported));
    expect(status({ status: "unknown" }, false)).toBeUndefined();
    expect(status(login, false, false)).toBeUndefined();
    // Signed out, the last report has no account to show under.
    expect(status({ status: "unauthenticated" }, true)).toBeUndefined();
    // Just after another account signs in, the old report is gone but its windows are still
    // published; no usage clears them, where "waiting for a report" would keep them.
    expect(
      museStatusUsageLimits({
        auth: { ...login, email: "b@example.com" },
        enabled: true,
        observation: undefined,
        dropped: true,
        nowMs: reported,
      }),
    ).toBeUndefined();
  });

  it("starts a new account generation on a logout or another login", () => {
    const login = {
      status: "authenticated",
      type: "accountLogin",
      email: "a@example.com",
    } as const;
    const apiKey = { status: "authenticated", type: "apiKey", label: "API key" } as const;
    // The first login a check names is the one the hosts so far started under.
    const named = nextMuseUsageAccount({ generation: 0, identity: undefined }, login);
    expect(named).toEqual({ generation: 0, identity: "a@example.com" });
    expect(nextMuseUsageAccount(named, login)).toBe(named);
    // Nothing names the login without account/read, and an API key names no account.
    expect(nextMuseUsageAccount(named, { status: "unknown" })).toBe(named);
    expect(nextMuseUsageAccount(named, apiKey)).toBe(named);
    expect(museUsageAccount(apiKey)).toBeUndefined();
    const other = nextMuseUsageAccount(named, { ...login, email: "b@example.com" });
    expect(other).toEqual({ generation: 1, identity: "b@example.com" });
    const signedOut = nextMuseUsageAccount(other, { status: "unauthenticated" });
    expect(signedOut).toEqual({ generation: 2, identity: null });
    // Signing in again, even as the same account, starts another: a host from before the
    // logout may hold either login.
    expect(nextMuseUsageAccount(signedOut, { ...login, email: "b@example.com" })).toEqual({
      generation: 3,
      identity: "b@example.com",
    });
  });

  it("recognises Muse's wording for a Meta quota refusal only", () => {
    expect(
      isMuseUsageLimitFailure(
        "API error 429: Subscription quota exhausted. Your usage window resets soon. (rate_limit_error)",
      ),
    ).toBe(true);
    expect(isMuseUsageLimitFailure("API error 429: Rate limit exceeded. (rate_limit_error)")).toBe(
      false,
    );
    expect(isMuseUsageLimitFailure("API error 500: quota service unavailable")).toBe(false);
    expect(isMuseUsageLimitFailure(undefined)).toBe(false);
  });

  it("resumes a limited turn once every exhausted window has reset", () => {
    const exhausted = {
      ...observation,
      window: { ...observation.window, usedPercent: 100 },
      weekly: { ...observation.weekly, usedPercent: 100 },
    };
    expect(museUsageLimitResetAt(exhausted, reported)).toBe("2026-10-12T00:00:00.000Z");
    // A window that already reset no longer holds the turn back.
    expect(museUsageLimitResetAt(exhausted, observation.weekly.resetsAtMs)).toBeNull();
    expect(museUsageLimitResetAt({ ...exhausted, weekly: observation.weekly }, reported)).toBe(
      "2026-10-08T13:19:17.000Z",
    );
    expect(museUsageLimitResetAt(observation, reported)).toBeNull();
    expect(museUsageLimitResetAt(undefined, reported)).toBeNull();
  });

  it("reads the hub's record of the same report", () => {
    const hub = museUsageObservationFromHubSignals(
      {
        "X-Meta-Tier": "tier-1",
        "X-Meta-Window-Used-Percent": "0",
        "X-Meta-Window-Minutes": "300",
        "X-Meta-Window-Reset-At": "1791465557",
        "X-Meta-Weekly-Used-Percent": "5",
        "X-Meta-Weekly-Reset-At": "1791763200",
      },
      reported,
    );
    expect(hub).toEqual(observation);
    expect(museUsageWindows(hub!, reported)).toEqual(museUsageWindows(observation, reported));

    expect(
      museUsageObservationFromHubSignals(
        { "X-Meta-Weekly-Used-Percent": "5", "X-Meta-Weekly-Reset-At": "1791763200" },
        reported,
      ),
    ).toEqual({ observedAtMs: reported, weekly: observation.weekly });
    expect(museUsageObservationFromHubSignals({}, reported)).toBeUndefined();
    expect(
      museUsageObservationFromHubSignals(
        {
          "X-Meta-Window-Used-Percent": "",
          "X-Meta-Window-Minutes": "300",
          "X-Meta-Window-Reset-At": "1791465557",
          "X-Meta-Weekly-Used-Percent": "-1",
          "X-Meta-Weekly-Reset-At": "1791763200",
        },
        reported,
      ),
    ).toBeUndefined();
  });
});
