import { UsageLimitSourceId, type UsageLimitSourceSnapshot } from "@lathe/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveProxyPill,
  formatCountdownSeconds,
  looksLikeEmailCode,
  resetCreditSlots,
  resetCreditsView,
  resetRedeemKey,
  selectProxySource,
} from "./ProxyUsagePill.logic";

const now = Date.parse("2026-09-23T12:00:00Z");
const at = (hours: number) => new Date(now + hours * 3_600_000).toISOString();

function account(
  id: string,
  windows: Array<[id: string, usedPercent: number, resetsAt?: string]>,
  proxy: NonNullable<UsageLimitSourceSnapshot["accounts"][number]["proxy"]>,
): UsageLimitSourceSnapshot["accounts"][number] {
  return {
    id,
    driver: "claudeAgent" as never,
    usageLimits: {
      checkedAt: at(0),
      windows: windows.map(([windowId, usedPercent, resetsAt]) => ({
        id: windowId,
        kind: windowId === "five_hour" ? ("session" as const) : ("weekly" as const),
        label: windowId,
        usedPercent,
        ...(resetsAt ? { resetsAt } : {}),
      })),
    },
    proxy,
  };
}

function snapshot(overrides: Partial<UsageLimitSourceSnapshot> = {}): UsageLimitSourceSnapshot {
  return {
    id: UsageLimitSourceId.make("modelproxy-iris"),
    kind: "modelproxy",
    label: "iris",
    checkedAt: at(0),
    accounts: [
      account(
        "james-max",
        [
          ["five_hour", 62, at(2)],
          ["seven_day", 41, at(100)],
        ],
        {
          state: "live",
          inflight: 2,
        },
      ),
      account(
        "zeus-pro",
        [
          ["five_hour", 96, at(1.7)],
          ["seven_day", 58, at(90)],
        ],
        {
          state: "ready",
          inflight: 0,
        },
      ),
    ],
    proxy: {
      auth: { state: "signedIn" },
      current: "james-max",
      rotationThresholdPercent: 90,
      modelThresholdPercent: 85,
      runway: { kind: "at", at: at(4.34) },
      fallback: [{ name: "openrouter-main", provider: "openrouter", spendUsd: 3.4, window: "day" }],
      inflightTotal: 2,
      queueDepth: 0,
    },
    ...overrides,
  };
}

describe("selectProxySource", () => {
  const gateway = snapshot();
  const hub = { ...snapshot(), kind: "cliproxy" as const };

  it("prefers the thread's environment, then the primary, then any other", () => {
    const configs = new Map([
      ["mac", { usageLimitSources: [gateway] }],
      ["hephaestus", { usageLimitSources: [hub] }],
      ["incus", { usageLimitSources: [gateway] }],
    ]);
    expect(selectProxySource(configs, ["hephaestus", "mac"])?.environmentId).toBe("mac");
    expect(selectProxySource(configs, ["incus", "mac"])?.environmentId).toBe("incus");
    expect(selectProxySource(configs, ["hephaestus", null])?.environmentId).toBe("mac");
  });

  it("returns null when no environment has a gateway", () => {
    const configs = new Map([
      ["hephaestus", { usageLimitSources: [hub] }],
      ["mac", {}],
    ]);
    expect(selectProxySource(configs, ["hephaestus", "mac"])).toBeNull();
  });
});

describe("deriveProxyPill", () => {
  it("ignores sources that are not a gateway", () => {
    expect(deriveProxyPill({ ...snapshot(), kind: "cliproxy" }, now)).toBeNull();
  });

  it("shows the serving account, its session tone, and the fleet runway", () => {
    const pill = deriveProxyPill(snapshot(), now)!;
    expect(pill.status).toBe("live");
    expect(pill.current?.id).toBe("james-max");
    expect(pill.current?.headline).toBe("62%");
    expect(pill.current?.stateLabel).toBe("live now · 2 in flight");
    expect(pill.tone).toBe("warn");
    expect(pill.runwayText).toBe("4h 20m");
    expect(pill.fallbackText).toBeNull();
    expect(pill.footer).toBe("threshold 90% · model 85% · 2 in flight");
    expect(pill.accounts.every((account) => account.resetCredits === null)).toBe(true);
  });

  it("lets a spent shared window govern the account's runway", () => {
    const pill = deriveProxyPill(snapshot(), now)!;
    const zeus = pill.accounts[1]!;
    expect(zeus.stateLabel).toBe("5h spent");
    expect(zeus.stateTone).toBe("crit");
    expect(zeus.runwayText).toBe("1h 42m");
    expect(zeus.windows[0]?.tone).toBe("crit");
  });

  it("keeps an account on credits selectable but warns", () => {
    const pill = deriveProxyPill(
      snapshot({
        accounts: [
          account("codex-james", [["five_hour", 100, at(1)]], {
            state: "ready",
            inflight: 0,
            credits: true,
          }),
        ],
        proxy: { auth: { state: "signedIn" }, current: "codex-james" },
      }),
      now,
    )!;
    expect(pill.accounts[0]?.stateLabel).toBe("on credits");
    expect(pill.accounts[0]?.runwayText).toBe("credits");
  });

  it("reports the fallback spend once the whole pool is spent", () => {
    const pill = deriveProxyPill(
      snapshot({
        accounts: [
          account("james-max", [["five_hour", 100, at(2)]], { state: "ready", inflight: 0 }),
          account("zeus-pro", [["five_hour", 96, at(1.7)]], {
            state: "cooling",
            inflight: 0,
            coolingUntil: at(0.01),
          }),
        ],
        proxy: { ...snapshot().proxy!, current: undefined },
      }),
      now,
    )!;
    expect(pill.current).toBeNull();
    expect(pill.tone).toBe("crit");
    expect(pill.fallbackText).toBe("$3.40 today");
  });

  it("surfaces sign-in state and the pending code", () => {
    const signedOut = deriveProxyPill(
      snapshot({ accounts: [], error: "Not signed in.", proxy: { auth: { state: "signedOut" } } }),
      now,
    )!;
    expect(signedOut.status).toBe("signedOut");
    expect(signedOut.pending).toBeNull();
    const pending = deriveProxyPill(
      snapshot({
        accounts: [],
        error: "Sign-in pending.",
        proxy: {
          auth: {
            state: "pending",
            userCode: "ABCD-EFGH",
            verificationUrl: "https://auth.test/device",
            verificationUrlComplete: "https://auth.test/device?user_code=ABCD-EFGH",
            expiresAt: at(0.1),
          },
        },
      }),
      now,
    )!;
    expect(pending.status).toBe("pending");
    expect(pending.pending).toEqual({
      userCode: "ABCD-EFGH",
      verificationUrl: "https://auth.test/device?user_code=ABCD-EFGH",
      expiresAt: at(0.1),
    });
  });

  it("counts down to the second when asked, so a watcher sees the clock move", () => {
    expect(formatCountdownSeconds(3 * 86_400_000 + 4 * 3_600_000 + 5_000)).toBe("3d 04h");
    expect(formatCountdownSeconds(19 * 3_600_000 + 17 * 60_000 + 9_000)).toBe("19:17:09");
    expect(formatCountdownSeconds(42_000)).toBe("0:00:42");
    const pill = deriveProxyPill(snapshot(), now, { seconds: true })!;
    expect(pill.accounts[1]?.runwayText).toBe("1:42:00");
    expect(pill.runwayText).toBe("4:20:24");
    // Off by default: the header pill ticks by the minute and reads the short form.
    expect(deriveProxyPill(snapshot(), now)!.accounts[1]?.runwayText).toBe("1h 42m");
  });

  it("counts down to every window's reset, not only the one that comes first", () => {
    const pill = deriveProxyPill(snapshot(), now, { seconds: true })!;
    // The runway follows the sooner session reset; the weekly reset still gets its own clock.
    expect(pill.accounts[1]?.windows.map((window) => [window.label, window.resetText])).toEqual([
      ["5h", "1:42:00"],
      ["7d", "3d 18h"],
    ]);
    const unknown = deriveProxyPill(
      snapshot({ accounts: [account("new", [["seven_day", 5]], { state: "ready", inflight: 0 })] }),
      now,
      { seconds: true },
    )!;
    expect(unknown.accounts[0]?.windows[0]?.resetText).toBe("");
  });

  it("marks a signed-in source that failed to read as offline", () => {
    const pill = deriveProxyPill(
      snapshot({ accounts: [], error: "The gateway did not answer." }),
      now,
    )!;
    expect(pill.status).toBe("offline");
    expect(pill.error).toBe("The gateway did not answer.");
    expect(pill.tone).toBe("muted");
  });
});

describe("account logins", () => {
  const flagged = (logins?: NonNullable<UsageLimitSourceSnapshot["proxy"]>["accountLogins"]) =>
    snapshot({
      accounts: [
        account("claude-1", [], { state: "reauthentication", inflight: 0 }),
        account("james-max", [["five_hour", 10, at(2)]], { state: "live", inflight: 0 }),
      ],
      proxy: {
        auth: { state: "signedIn" },
        current: "james-max",
        ...(logins ? { accountLogins: logins } : {}),
      },
    });
  const login = {
    account: "claude-1",
    sessionId: "s1",
    mode: "paste" as const,
    state: "awaiting_code" as const,
    authorizeUrl: "https://claude.com/cai/oauth/authorize",
    expiresAt: at(0.2),
  };

  it("counts the accounts that need a login and marks their rows", () => {
    const pill = deriveProxyPill(flagged(), now)!;
    expect(pill.needsLogin).toBe(1);
    expect(pill.accounts[0]!.needsLogin).toBe(true);
    expect(pill.accounts[0]!.login).toBeNull();
    expect(pill.accounts[1]!.needsLogin).toBe(false);
  });

  it("asks for the pasted code, and says what to do when one is refused", () => {
    const waiting = deriveProxyPill(flagged([login]), now)!.accounts[0]!.login!;
    expect(waiting.step).toBe("paste");
    expect(waiting.authorizeUrl).toBe(login.authorizeUrl);
    expect(waiting.message).toBeNull();

    const refused = deriveProxyPill(
      flagged([{ ...login, errorCode: "bad_code", error: "that code did not work" }]),
      now,
    )!.accounts[0]!.login!;
    expect(refused.step).toBe("paste");
    expect(refused.message).toMatch(/didn't work/);
  });

  it("explains an emailed sign-in code, and relays codes it does not know", () => {
    const email = deriveProxyPill(
      flagged([{ ...login, errorCode: "email_code", error: "gateway words" }]),
      now,
    )!.accounts[0]!.login!;
    expect(email.step).toBe("paste");
    expect(email.message).toMatch(/sign-in page/);

    const unknown = deriveProxyPill(
      flagged([{ ...login, errorCode: "something_new", error: "the gateway says why" }]),
      now,
    )!.accounts[0]!.login!;
    expect(unknown.message).toBe("the gateway says why");
  });

  it("recognises a pasted email sign-in code before sending it", () => {
    expect(looksLikeEmailCode("251063")).toBe(true);
    expect(looksLikeEmailCode(" 2510-63 ")).toBe(true);
    expect(looksLikeEmailCode("abcDEF123#xyz")).toBe(false);
    expect(looksLikeEmailCode("12")).toBe(false);
  });

  it("shows a device code to approve, then the outcome", () => {
    const device = {
      ...login,
      mode: "device" as const,
      state: "awaiting_approval" as const,
      userCode: "ABCD-EFGH",
      verificationUrl: "https://auth.openai.com/codex/device",
    };
    const approve = deriveProxyPill(flagged([device]), now)!.accounts[0]!.login!;
    expect(approve.step).toBe("approve");
    expect(approve.userCode).toBe("ABCD-EFGH");

    const mismatch = deriveProxyPill(
      flagged([
        {
          ...device,
          state: "failed",
          errorCode: "identity_mismatch",
          error: "signed in as other@example.com",
        },
      ]),
      now,
    )!.accounts[0]!.login!;
    expect(mismatch.step).toBe("failed");
    expect(mismatch.message).toBe("signed in as other@example.com");

    const saved = deriveProxyPill(
      flagged([{ ...device, state: "completed", errorCode: "save_failed" }]),
      now,
    )!.accounts[0]!.login!;
    expect(saved.step).toBe("done");
    expect(saved.message).toMatch(/restart/);
  });
});

describe("ledger groups", () => {
  const idle = { state: "ready" as const, inflight: 0 };
  const pool = () =>
    snapshot({
      accounts: [
        account("spent-late", [["seven_day", 100, at(40)]], idle),
        { ...account("codex", [["seven_day", 3, at(50)]], idle), driver: "codex" as never },
        account("ready-b", [["five_hour", 10, at(3)]], idle),
        account("spent-soon", [["seven_day", 100, at(19)]], idle),
        account("paused", [["five_hour", 0, at(3)]], { state: "paused", inflight: 0 }),
        account("serving", [["five_hour", 0, at(4)]], { state: "live", inflight: 0 }),
        account("ready-a", [["five_hour", 20, at(3)]], idle),
      ],
      proxy: { ...snapshot().proxy!, current: "serving" },
    });

  it("groups accounts by provider, Anthropic before OpenAI", () => {
    const pill = deriveProxyPill(pool(), now)!;
    expect(pill.groups.map((group) => group.label)).toEqual(["Anthropic", "OpenAI"]);
    expect(pill.groups[1]!.available.map((account) => account.id)).toEqual(["codex"]);
  });

  it("puts the serving account first, then ready accounts by name", () => {
    const anthropic = deriveProxyPill(pool(), now)!.groups[0]!;
    expect(anthropic.available.map((account) => account.id)).toEqual([
      "serving",
      "ready-a",
      "ready-b",
    ]);
  });

  it("lists unavailable accounts below, soonest back first, untimed ones last", () => {
    const anthropic = deriveProxyPill(pool(), now)!.groups[0]!;
    expect(anthropic.unavailable.map((account) => account.id)).toEqual([
      "spent-soon",
      "spent-late",
      "paused",
    ]);
  });

  it("keeps an account on credits with the available ones", () => {
    const pill = deriveProxyPill(
      snapshot({
        accounts: [account("credits", [["seven_day", 100, at(10)]], { ...idle, credits: true })],
      }),
      now,
    )!;
    expect(pill.groups[0]!.available.map((account) => account.id)).toEqual(["credits"]);
  });
});

describe("model windows", () => {
  it("shows a known model's window as its glyph, titled in full", () => {
    const pill = deriveProxyPill(
      snapshot({
        accounts: [
          {
            ...account("fable-user", [], { state: "live", inflight: 0 }),
            usageLimits: {
              checkedAt: at(0),
              windows: [
                { id: "seven_day_fable", kind: "weekly", label: "Weekly · Fable", usedPercent: 35 },
                { id: "seven_day_other", kind: "weekly", label: "Weekly · Other", usedPercent: 5 },
              ],
            },
          },
        ],
      }),
      now,
    )!;
    const [fable, other] = pill.accounts[0]!.windows;
    expect(fable).toMatchObject({ glyph: "feather", title: "Weekly · Fable" });
    expect(other).toMatchObject({ glyph: null, label: "other", title: "Weekly · Other" });
  });
});

describe("resetCreditsView", () => {
  it("shows weekly and Fable resets apart", () => {
    const view = resetCreditsView(
      {
        availableCount: 1,
        usableNowCount: 1,
        nextCreditId: "weekly" as never,
        nextExpiresAt: at(48) as never,
        fable: { availableCount: 3, nextCreditId: "fable" as never },
      },
      now,
    );
    expect(view?.text).toBe("↻1 · F3");
    expect(view?.muted).toBe(false);
    expect(view?.tooltip).toContain("1 weekly reset");
    expect(view?.tooltip).toContain("3 Fable resets");
    expect(view?.weekly?.nextCreditId).toBe("weekly");
    expect(view?.fable?.availableCount).toBe(3);
  });

  it("mutes resets that cannot act yet", () => {
    const view = resetCreditsView({ availableCount: 3, usableNowCount: 0 }, now);
    expect(view?.text).toBe("↻3");
    expect(view?.muted).toBe(true);
    expect(view?.tooltip).toContain("None usable until a limit is reached");
    expect(view?.fable).toBeNull();
  });

  it("shows nothing when nothing is banked or known", () => {
    expect(resetCreditsView(undefined, now)).toBeNull();
    expect(resetCreditsView({ availableCount: 0 }, now)).toBeNull();
  });
});

describe("resetCreditsView expiry and Fable", () => {
  const weekly = (nextExpiresAt?: string) =>
    resetCreditsView(
      {
        availableCount: 2,
        usableNowCount: 1,
        nextCreditId: "weekly" as never,
        ...(nextExpiresAt ? { nextExpiresAt: nextExpiresAt as never } : {}),
      },
      now,
    );

  it("counts down to a future expiry", () => {
    expect(weekly(at(2))?.tooltip).toBe("2 weekly resets, next expires in 2h 0m");
  });

  it("says a passed expiry expires now", () => {
    const tooltip = weekly(at(-1))?.tooltip;
    expect(tooltip).toBe("2 weekly resets, next expires now");
    expect(tooltip).not.toContain("in now");
  });

  it("leaves out an expiry it cannot read", () => {
    expect(weekly("not a date")?.tooltip).toBe("2 weekly resets");
  });

  it("shows a Fable-only account with no weekly resets, not muted", () => {
    const view = resetCreditsView(
      {
        availableCount: 0,
        usableNowCount: 0,
        fable: {
          availableCount: 3,
          nextCreditId: "fable" as never,
          nextExpiresAt: at(-2) as never,
        },
      },
      now,
    );
    expect(view?.text).toBe("↻0 · F3");
    expect(view?.muted).toBe(false);
    expect(view?.tooltip).toBe("3 Fable resets, next expires now");
    expect(view?.weekly).toBeNull();
    expect(view?.fable).toEqual({
      availableCount: 3,
      nextCreditId: "fable",
      nextExpiresAt: at(-2),
    });
  });

  it("keeps the Fable bucket out of the weekly one", () => {
    const view = resetCreditsView(
      {
        availableCount: 1,
        usableNowCount: 1,
        nextCreditId: "weekly" as never,
        fable: { availableCount: 2, nextCreditId: "fable" as never },
      },
      now,
    );
    expect(view?.weekly).not.toHaveProperty("fable");
  });
});

describe("deriveProxyPill reset credits", () => {
  it("carries an account's banked resets onto its row", () => {
    const base = snapshot();
    const [first, ...rest] = base.accounts;
    const pill = deriveProxyPill(
      {
        ...base,
        accounts: [
          {
            ...first!,
            usageLimits: {
              ...first!.usageLimits,
              resetCredits: {
                availableCount: 1,
                usableNowCount: 0,
                nextCreditId: "weekly" as never,
              },
            },
          },
          ...rest,
        ],
      },
      now,
    )!;
    const row = pill.accounts.find((account) => account.id === "james-max");
    expect(row?.resetCredits?.text).toBe("↻1");
    expect(row?.resetCredits?.muted).toBe(true);
    expect(row?.resetCredits?.tooltip).toContain("None usable until a limit is reached");
    expect(row?.resetCredits?.weekly?.nextCreditId).toBe("weekly");
    expect(pill.accounts.find((account) => account.id === "zeus-pro")?.resetCredits).toBeNull();
  });
});

describe("resetCreditSlots", () => {
  const row = (credits: Parameters<typeof resetCreditsView>[0]) => ({
    id: "claude-1",
    resetCredits: resetCreditsView(credits, now),
  });
  const weeklyOnly = { availableCount: 1, usableNowCount: 1, nextCreditId: "weekly" as never };

  it("offers each bucket with resets banked", () => {
    const slots = resetCreditSlots(
      row({ ...weeklyOnly, fable: { availableCount: 2, nextCreditId: "fable" as never } }),
      new Map(),
    );
    expect(slots.map((slot) => [slot.kind, slot.credits.availableCount, slot.redeem])).toEqual([
      ["weekly", 1, null],
      ["fable", 2, null],
    ]);
  });

  it("keeps a bucket whose count dropped to zero while it holds an answer", () => {
    const answered = new Map([
      [resetRedeemKey("claude-1", "weekly"), { busy: false, status: "Reset applied." }],
    ]);
    const slots = resetCreditSlots(row({ availableCount: 0, usableNowCount: 0 }), answered);
    expect(slots).toEqual([
      {
        kind: "weekly",
        credits: { availableCount: 0 },
        redeem: { busy: false, status: "Reset applied." },
      },
    ]);
  });

  it("keeps a bucket while its redemption is still in flight", () => {
    const busy = new Map([[resetRedeemKey("claude-1", "fable"), { busy: true, status: null }]]);
    expect(resetCreditSlots(row(undefined), busy).map((slot) => slot.kind)).toEqual(["fable"]);
  });

  it("offers nothing when no bucket is banked and nothing is held", () => {
    const idle = new Map([[resetRedeemKey("claude-1", "weekly"), { busy: false, status: null }]]);
    expect(resetCreditSlots(row(undefined), idle)).toEqual([]);
    // Another account's answer stays with that account.
    const elsewhere = new Map([
      [resetRedeemKey("claude-2", "weekly"), { busy: false, status: "Reset applied." }],
    ]);
    expect(resetCreditSlots(row(undefined), elsewhere)).toEqual([]);
  });
});
