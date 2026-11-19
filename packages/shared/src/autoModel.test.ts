import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
  type ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  AUTO_LEVEL_MODELS,
  autoLevelSelection,
  isAutoModelSelection,
  isAutoModelSlug,
  resolveAutoModelSelection,
} from "./autoModel.ts";

const now = Date.parse("2026-11-12T12:00:00.000Z");
const resetsAt = "2026-11-12T15:00:00.000Z";
const inHours = (hours: number) => DateTime.formatIso(DateTime.makeUnsafe(now + hours * 3_600_000));

const effortCapabilities = {
  optionDescriptors: [
    {
      id: "effort",
      label: "Effort",
      type: "select" as const,
      options: ["low", "medium", "high", "xhigh", "max"].map((id) => ({ id, label: id })),
    },
  ],
};

function claude(id: string, usedPercent: number, autoAware = true): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(id),
    driver: ProviderDriverKind.make("claudeAgent"),
    ...(autoAware ? { displayName: id.endsWith("B") ? "Auto B" : "Auto" } : {}),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-11-12T11:00:00.000Z",
    models: [
      ...["claude-fable-5-2", "claude-opus-5-5", "claude-sonnet-5-5"].map((slug) => ({
        slug,
        name: slug,
        isCustom: false,
        capabilities: effortCapabilities,
      })),
      // Every Claude provider lists the Auto levels; only "Auto" instances carry the Auto prompt.
      ...AUTO_LEVEL_MODELS.map((model) => ({ ...model, isCustom: false, capabilities: {} })),
    ],
    slashCommands: [],
    skills: [],
    usageLimits: {
      windows: [{ id: "five_hour", kind: "session", label: "Session", usedPercent, resetsAt }],
    },
  } as unknown as ServerProvider;
}

function withWeekly(
  provider: ServerProvider,
  usedPercent: number,
  weeklyResetsAt: string,
  id = "seven_day",
) {
  return {
    ...provider,
    usageLimits: {
      windows: [
        ...(provider.usageLimits?.windows ?? []),
        { id, kind: "weekly", label: "Weekly", usedPercent, resetsAt: weeklyResetsAt },
      ],
    },
  } as unknown as ServerProvider;
}

function withWindow(provider: ServerProvider, window: Record<string, unknown>) {
  return {
    ...provider,
    usageLimits: {
      windows: [...(provider.usageLimits?.windows ?? []), window],
    },
  } as unknown as ServerProvider;
}

const antigravityProvider = (id: string, geminiSession: number, claudeSession: number) =>
  ({
    ...claude(id, 0, false),
    displayName: "Auto",
    driver: ProviderDriverKind.make("antigravity"),
    models: [
      {
        slug: "claude-opus-4-6-thinking",
        name: "Claude Opus 4.6",
        isCustom: false,
        capabilities: {
          optionDescriptors: [
            {
              id: "thinking_level",
              label: "Thinking",
              type: "select" as const,
              options: [{ id: "medium", label: "medium" }],
            },
          ],
        },
      },
    ],
    usageLimits: {
      windows: [
        {
          id: "gemini-5h",
          kind: "session",
          label: "Gemini session",
          usedPercent: geminiSession,
          resetsAt,
        },
        {
          id: "claude-5h",
          kind: "session",
          label: "Claude session",
          usedPercent: claudeSession,
          resetsAt,
        },
      ],
    },
  }) as unknown as ServerProvider;

const auto = (level?: string): ModelSelection => ({
  instanceId: ProviderInstanceId.make("claudeAuto"),
  model: "auto",
  ...(level ? { options: [{ id: "effort", value: level }] } : {}),
});

const routeTo = (providers: ReadonlyArray<ServerProvider>) =>
  resolveAutoModelSelection({ selection: auto(), providers, now })?.selection.instanceId;

describe("resolveAutoModelSelection", () => {
  it("maps each level to its orchestrator model and effort, medium by default", () => {
    const providers = [claude("claudeAuto", 10)];
    expect(
      resolveAutoModelSelection({ selection: auto("high"), providers, now })?.selection,
    ).toEqual({
      instanceId: "claudeAuto",
      model: "claude-opus-5-5",
      options: [
        { id: "effort", value: "max" },
        { id: "auto", value: "high" },
      ],
    });
    expect(resolveAutoModelSelection({ selection: auto(), providers, now })?.selection.model).toBe(
      "claude-opus-5-5",
    );
    expect(
      resolveAutoModelSelection({ selection: auto("low"), providers, now })?.selection,
    ).toEqual({
      instanceId: "claudeAuto",
      model: "claude-sonnet-5-5",
      options: [
        { id: "effort", value: "low" },
        { id: "auto", value: "low" },
      ],
    });
  });

  it("prefers Auto-aware instances", () => {
    const providers = [claude("claudeAgent", 0, false), claude("claudeAutoB", 20)];
    expect(
      resolveAutoModelSelection({ selection: auto("medium"), providers, now })?.selection
        .instanceId,
    ).toBe("claudeAutoB");
    // Same account, so same usage: the plain instance comes first in the registry.
    const sameAccount = [claude("claudeAgent", 20, false), claude("claudeAuto", 20)];
    expect(
      resolveAutoModelSelection({ selection: auto("medium"), providers: sameAccount, now })
        ?.selection.instanceId,
    ).toBe("claudeAuto");
  });

  it("keeps the thread's current model until it passes 90% used", () => {
    const current = { instanceId: ProviderInstanceId.make("claudeAuto"), model: "claude-opus-5-5" };
    const calm = [claude("claudeAuto", 60), claude("claudeAutoB", 5)];
    expect(
      resolveAutoModelSelection({ selection: auto(), providers: calm, now, current }),
    ).toMatchObject({ sticky: true, selection: { instanceId: "claudeAuto" } });

    const busy = [claude("claudeAuto", 95), claude("claudeAutoB", 5)];
    expect(
      resolveAutoModelSelection({ selection: auto(), providers: busy, now, current }),
    ).toMatchObject({ sticky: false, selection: { instanceId: "claudeAutoB" } });

    // A higher weekly pace elsewhere does not move a thread whose account still has room.
    const onB = { instanceId: ProviderInstanceId.make("claudeAutoB"), model: "claude-opus-5-5" };
    const urgentA = [
      withWeekly(claude("claudeAuto", 10), 68, inHours(52.8)),
      withWeekly(claude("claudeAutoB", 45), 40, inHours(149.8)),
    ];
    expect(
      resolveAutoModelSelection({ selection: auto(), providers: urgentA, now, current: onB }),
    ).toMatchObject({ sticky: true, selection: { instanceId: "claudeAutoB" } });
  });

  it("steps down to other subscriptions when both Claude accounts are exhausted", () => {
    const grok = {
      ...claude("grok", 0, false),
      driver: ProviderDriverKind.make("grok"),
      models: [{ slug: "grok-4.7", name: "Grok 4.7", isCustom: false, capabilities: null }],
      usageLimits: undefined,
    } as unknown as ServerProvider;
    const providers = [claude("claudeAuto", 100), claude("claudeAutoB", 100), grok];
    expect(
      resolveAutoModelSelection({ selection: auto(), providers, now })?.selection,
    ).toMatchObject({
      instanceId: "grok",
      model: "grok-4.7",
    });
  });

  it("drains the account whose 5-hour window is already running, so the windows stagger", () => {
    // A's window is half spent; B stays untouched and its window starts only when A is nearly
    // out, so A refreshes while B is in use.
    const providers = [
      withWeekly(claude("claudeAutoB", 0), 20, "2026-11-18T12:00:00.000Z"),
      withWeekly(claude("claudeAuto", 50), 20, "2026-11-18T12:00:00.000Z"),
    ];
    expect(
      resolveAutoModelSelection({ selection: auto(), providers, now })?.selection.instanceId,
    ).toBe("claudeAuto");
    // Weekly paces within 15% count as equal: B's 0.54%/h does not beat A's 0.5%/h.
    const closePaces = [
      withWeekly(claude("claudeAutoB", 10), 46, inHours(100)),
      withWeekly(claude("claudeAuto", 50), 50, inHours(100)),
    ];
    expect(routeTo(closePaces)).toBe("claudeAuto");
  });

  it("spends first the account whose weekly quota would be lost at its reset", () => {
    // 2026-11-19 07:15 CET: A has 32% left for 52.8 h (0.61%/h), B 60% for 149.8 h (0.40%/h).
    // B's 5-hour window is further along, but A's quota is gone in two days.
    const route = (aWeeklyUsed: number) =>
      routeTo([
        withWeekly(claude("claudeAutoB", 45), 40, inHours(149.8)),
        withWeekly(claude("claudeAuto", 10), aWeeklyUsed, inHours(52.8)),
      ]);
    expect(route(68)).toBe("claudeAuto");
    // With 15% left (0.28%/h), A has less to lose and waits; at 97% it has no room at all.
    expect(route(85)).toBe("claudeAutoB");
    expect(route(97)).toBe("claudeAutoB");
  });

  it("ranks an account without weekly data after one with it", () => {
    // A's 5-hour window is further along, but A's weekly use is unknown, not 0%.
    const providers = [
      claude("claudeAuto", 50),
      withWeekly(claude("claudeAutoB", 10), 40, inHours(100)),
    ];
    expect(routeTo(providers)).toBe("claudeAutoB");

    // A weekly window that has not started reports no reset; it runs a full week from now
    // (0.6%/h), so the fresh account beats A's 0.47%/h.
    const unstarted = {
      ...claude("claudeAutoB", 0),
      usageLimits: {
        windows: [
          {
            id: "seven_day",
            kind: "weekly",
            label: "Weekly",
            usedPercent: 0,
            windowDurationMins: 10_080,
          },
        ],
      },
    } as unknown as ServerProvider;
    expect(routeTo([withWeekly(claude("claudeAuto", 50), 30, inHours(150)), unstarted])).toBe(
      "claudeAutoB",
    );
  });

  it("counts a one-model weekly window only for that model", () => {
    // A's nearly spent Opus allowance resets late, so A has little Opus quota to lose. B's nearly
    // spent allowance is Fable's, which does not slow B's Opus pace.
    const providers = [
      withWeekly(
        withWeekly(claude("claudeAuto", 50), 20, inHours(30)),
        85,
        inHours(140),
        "seven_day_opus",
      ),
      withWeekly(
        withWeekly(claude("claudeAutoB", 10), 50, inHours(100)),
        85,
        inHours(140),
        "seven_day_fable",
      ),
    ];
    expect(routeTo(providers)).toBe("claudeAutoB");
  });

  it("checks room only against windows that limit the candidate model", () => {
    const weeklyReset = inHours(48);
    const a = withWindow(withWeekly(claude("claudeAuto", 50), 20, weeklyReset), {
      id: "seven_day_fable",
      kind: "weekly",
      label: "Weekly · Fable",
      usedPercent: 95,
      resetsAt: weeklyReset,
    });
    const b = withWeekly(claude("claudeAutoB", 10), 20, weeklyReset);
    expect(routeTo([a, b])).toBe("claudeAuto");

    const grok = {
      ...claude("grok", 10, false),
      driver: ProviderDriverKind.make("grok"),
      models: [{ slug: "grok-4.7", name: "Grok 4.7", isCustom: false, capabilities: null }],
    } as unknown as ServerProvider;
    const current = { instanceId: ProviderInstanceId.make("grok"), model: "grok-4.7" };
    expect(
      resolveAutoModelSelection({ selection: auto(), providers: [grok, a], now, current }),
    ).toMatchObject({ sticky: false, selection: { instanceId: "claudeAuto" } });
  });

  it("checks room only against the Antigravity pool that limits the model", () => {
    const out = [claude("claudeAuto", 100), claude("claudeAutoB", 100)];
    expect(
      routeTo([
        ...out,
        antigravityProvider("antigravityA", 92, 50),
        antigravityProvider("antigravityB", 10, 10),
      ]),
    ).toBe("antigravityA");
  });

  it("does not count Claude's extra-usage spend window for room", () => {
    const a = withWindow(withWeekly(claude("claudeAuto", 50), 20, inHours(48)), {
      id: "monthly_spend",
      kind: "monthly",
      label: "Monthly spend",
      usedPercent: 95,
    });
    const b = withWeekly(claude("claudeAutoB", 10), 20, inHours(48));
    expect(routeTo([a, b])).toBe("claudeAuto");
    const spentPastPlan = withWindow(claude("claudeAuto", 92), {
      id: "monthly_spend",
      kind: "monthly",
      label: "Monthly spend",
      usedPercent: 99,
    });
    expect(routeTo([claude("claudeAutoB", 95), spentPastPlan])).toBe("claudeAuto");
  });

  it("ignores a window whose reset has already passed when checking room", () => {
    const a = {
      ...claude("claudeAuto", 0),
      usageLimits: {
        windows: [
          {
            id: "five_hour",
            kind: "session",
            label: "Session",
            usedPercent: 95,
            resetsAt: inHours(-1),
          },
          {
            id: "seven_day",
            kind: "weekly",
            label: "Weekly",
            usedPercent: 0,
            resetsAt: inHours(168),
          },
        ],
      },
    } as unknown as ServerProvider;
    const b = withWeekly(claude("claudeAutoB", 10), 40, inHours(168));
    expect(routeTo([a, b])).toBe("claudeAuto");
  });

  it("ranks unknown usage after an account with known room", () => {
    const known = withWeekly(claude("claudeAuto", 0), 30, inHours(100));
    // Grok's credits response omits creditUsagePercent on a unified-billing subscription; its
    // reader currently turns that into a fabricated 0%. Without a reading it is unknown, not empty.
    const unknown = {
      ...claude("claudeAutoB", 0),
      usageLimits: {
        windows: [
          {
            id: "subscription",
            kind: "weekly",
            label: "Weekly",
            resetsAt: inHours(100),
            windowDurationMins: 10_080,
          },
        ],
      },
    } as unknown as ServerProvider;
    expect(routeTo([known, unknown])).toBe("claudeAuto");
    expect(routeTo([unknown, known])).toBe("claudeAuto");

    const noReport = {
      ...claude("claudeAutoB", 0),
      usageLimits: undefined,
    } as unknown as ServerProvider;
    expect(routeTo([known, noReport])).toBe("claudeAuto");
    expect(routeTo([noReport, known])).toBe("claudeAuto");
    expect(routeTo([noReport, claude("claudeAuto", 95)])).toBe("claudeAutoB");
    expect(routeTo([unknown, claude("claudeAuto", 95)])).toBe("claudeAutoB");
    expect(routeTo([noReport])).toBe("claudeAutoB");
    // A known window past 90% outranks an unknown one: the account has no room.
    const partlyUnknown = withWindow(claude("claudeAutoB", 95), {
      id: "seven_day",
      kind: "weekly",
      label: "Weekly",
      resetsAt: inHours(100),
    });
    expect(routeTo([partlyUnknown, claude("claudeAuto", 92)])).toBe("claudeAuto");
  });

  it("ranks an account with no session window after one with a known session", () => {
    const noSession = {
      ...claude("claudeAutoB", 0),
      usageLimits: {
        windows: [
          {
            id: "seven_day",
            kind: "weekly",
            label: "Weekly",
            usedPercent: 30,
            resetsAt: inHours(100),
          },
        ],
      },
    } as unknown as ServerProvider;
    const known = withWeekly(claude("claudeAuto", 0), 30, inHours(100));
    expect(routeTo([noSession, known])).toBe("claudeAuto");
  });

  it("does not let unknown usage pull a sticky thread off a known account", () => {
    const openCode = {
      ...claude("openCode", 10, false),
      driver: ProviderDriverKind.make("opencode"),
      models: [
        {
          slug: "opencode/big-pickle",
          name: "Big Pickle",
          isCustom: false,
          capabilities: {
            optionDescriptors: [
              {
                id: "variant",
                label: "Variant",
                type: "select" as const,
                options: [{ id: "medium", label: "medium" }],
              },
            ],
          },
        },
      ],
    } as unknown as ServerProvider;
    const grok = {
      ...claude("grok", 0, false),
      driver: ProviderDriverKind.make("grok"),
      models: [{ slug: "grok-4.7", name: "Grok 4.7", isCustom: false, capabilities: null }],
      usageLimits: {
        windows: [
          {
            id: "subscription",
            kind: "weekly",
            label: "Weekly",
            resetsAt: inHours(100),
            windowDurationMins: 10_080,
          },
        ],
      },
    } as unknown as ServerProvider;
    const current = {
      instanceId: ProviderInstanceId.make("openCode"),
      model: "opencode/big-pickle",
    };
    expect(
      resolveAutoModelSelection({ selection: auto(), providers: [grok, openCode], now, current }),
    ).toMatchObject({ sticky: true, selection: { instanceId: "openCode" } });
  });

  it("switches to the other account once a 5-hour or weekly window is 90% used", () => {
    const sessionFull = [claude("claudeAuto", 92), claude("claudeAutoB", 0)];
    expect(
      resolveAutoModelSelection({ selection: auto(), providers: sessionFull, now })?.selection
        .instanceId,
    ).toBe("claudeAutoB");
    const weeklyFull = [
      withWeekly(claude("claudeAuto", 50), 95, "2026-11-18T12:00:00.000Z"),
      withWeekly(claude("claudeAutoB", 0), 20, "2026-11-18T12:00:00.000Z"),
    ];
    expect(
      resolveAutoModelSelection({ selection: auto(), providers: weeklyFull, now })?.selection
        .instanceId,
    ).toBe("claudeAutoB");
  });

  it("when every account is past 90%, uses the one with the most left", () => {
    const providers = [claude("claudeAuto", 92), claude("claudeAutoB", 97)];
    expect(
      resolveAutoModelSelection({ selection: auto(), providers, now })?.selection.instanceId,
    ).toBe("claudeAuto");
    // Fable's allowance does not limit Opus, so A's highest relevant window is its 92% session.
    const fableFull = withWindow(claude("claudeAuto", 92), {
      id: "seven_day_fable",
      kind: "weekly",
      label: "Weekly · Fable",
      usedPercent: 98,
      resetsAt: inHours(48),
    });
    expect(routeTo([fableFull, claude("claudeAutoB", 97)])).toBe("claudeAuto");
  });

  it("with similar weekly pace and 5-hour use, spends the account whose weekly limit resets first", () => {
    // Both paces are 0.42%/h and B's window is slightly further along, but A resets a day sooner.
    const providers = [
      withWeekly(claude("claudeAutoB", 30), 40, "2026-11-18T12:00:00.000Z"),
      withWeekly(claude("claudeAuto", 25), 50, "2026-11-17T12:00:00.000Z"),
    ];
    expect(
      resolveAutoModelSelection({ selection: auto(), providers, now })?.selection.instanceId,
    ).toBe("claudeAuto");
  });

  it("falls back to Claude on the Antigravity subscription before other providers", () => {
    const antigravity = {
      ...claude("antigravity", 0, false),
      driver: ProviderDriverKind.make("antigravity"),
      models: ["claude-opus-4-6-thinking", "claude-sonnet-4-6"].map((slug) => ({
        slug,
        name: slug,
        isCustom: false,
        capabilities: {
          optionDescriptors: [
            {
              id: "thinking_level",
              label: "Thinking",
              type: "select" as const,
              options: ["low", "medium", "high"].map((id) => ({ id, label: id })),
            },
          ],
        },
      })),
    } as unknown as ServerProvider;
    const providers = [claude("claudeAuto", 100), claude("claudeAutoB", 100), antigravity];
    expect(
      resolveAutoModelSelection({ selection: auto(), providers, now })?.selection,
    ).toMatchObject({
      instanceId: "antigravity",
      model: "claude-opus-4-6-thinking",
      options: [
        { id: "thinking_level", value: "medium" },
        { id: "auto", value: "medium" },
      ],
    });
  });

  it("after every Claude subscription, uses ChatGPT, then Grok, then Gemini", () => {
    const other = (id: string, driver: string, slug: string, optionId: string) =>
      ({
        ...claude(id, 0, false),
        driver: ProviderDriverKind.make(driver),
        models: [
          {
            slug,
            name: slug,
            isCustom: false,
            capabilities: {
              optionDescriptors: [
                {
                  id: optionId,
                  label: "Effort",
                  type: "select" as const,
                  options: ["low", "medium", "high"].map((value) => ({ id: value, label: value })),
                },
              ],
            },
          },
        ],
        usageLimits: undefined,
      }) as unknown as ServerProvider;
    const claudeOut = [claude("claudeAuto", 100), claude("claudeAutoB", 100)];
    const codex = other("codex", "codex", "gpt-6-luna", "reasoningEffort");
    const grok = other("grok", "grok", "grok-4.7", "reasoningEffort");
    const gemini = other("antigravity", "antigravity", "gemini-3.8-flash", "thinking_level");
    const route = (providers: ServerProvider[]) =>
      resolveAutoModelSelection({ selection: auto("high"), providers, now })?.selection;

    expect(route([...claudeOut, gemini, grok, codex])).toMatchObject({
      instanceId: "codex",
      model: "gpt-6-luna",
      options: [
        { id: "reasoningEffort", value: "high" },
        { id: "auto", value: "high" },
      ],
    });
    expect(route([...claudeOut, gemini, grok])?.instanceId).toBe("grok");
    expect(route([...claudeOut, gemini])).toMatchObject({
      instanceId: "antigravity",
      model: "gemini-3.8-flash",
      options: [
        { id: "thinking_level", value: "high" },
        { id: "auto", value: "high" },
      ],
    });
  });

  it("reads the level from auto-low / auto-medium / auto-high", () => {
    const providers = [claude("claudeAuto", 10)];
    const pick = (model: string) =>
      resolveAutoModelSelection({
        selection: { instanceId: ProviderInstanceId.make("claudeAuto"), model },
        providers,
        now,
      })?.selection.model;
    expect(pick("auto-high")).toBe("claude-opus-5-5");
    expect(pick("auto-medium")).toBe("claude-opus-5-5");
    expect(pick("auto-low")).toBe("claude-sonnet-5-5");
    expect(isAutoModelSlug("auto-low")).toBe(true);
    expect(isAutoModelSlug("auto-max")).toBe(false);

    // The routed model keeps its level, so the thread stays on Auto and clients show it.
    const routed = resolveAutoModelSelection({
      selection: auto("low"),
      providers,
      now,
    })!.selection;
    expect(isAutoModelSelection(routed)).toBe(true);
    expect(autoLevelSelection(routed)).toEqual({ instanceId: "claudeAuto", model: "auto-low" });
    expect(
      resolveAutoModelSelection({ selection: routed, providers, now, current: routed }),
    ).toMatchObject({ sticky: true, level: "low", selection: routed });
    const plain = { instanceId: ProviderInstanceId.make("claudeAuto"), model: "claude-opus-5-5" };
    expect(autoLevelSelection(plain)).toBe(plain);
  });

  it("skips blocked instances, the thread's current one included", () => {
    const current = { instanceId: ProviderInstanceId.make("claudeAuto"), model: "claude-opus-5-5" };
    const calm = [claude("claudeAuto", 20), claude("claudeAutoB", 5)];
    const blocked = (instanceId: string) => instanceId === "claudeAuto";
    expect(
      resolveAutoModelSelection({ selection: auto(), providers: calm, now, current, blocked }),
    ).toMatchObject({ sticky: false, selection: { instanceId: "claudeAutoB" } });
    expect(
      resolveAutoModelSelection({
        selection: auto(),
        providers: calm,
        now,
        current,
        blocked: () => true,
      }),
    ).toBeNull();
  });

  it("returns from a weaker fallback once a better model has room again", () => {
    const grok = {
      ...claude("grok", 0, false),
      driver: ProviderDriverKind.make("grok"),
      models: [{ slug: "grok-4.7", name: "Grok 4.7", isCustom: false, capabilities: null }],
      usageLimits: undefined,
    } as unknown as ServerProvider;
    const current = { instanceId: ProviderInstanceId.make("grok"), model: "grok-4.7" };
    const resolve = (claudeUsed: number) =>
      resolveAutoModelSelection({
        selection: auto(),
        providers: [claude("claudeAuto", claudeUsed), grok],
        now,
        current,
      });
    // Claude is back: the thread leaves Grok.
    expect(resolve(10)).toMatchObject({ sticky: false, selection: { instanceId: "claudeAuto" } });
    // Claude is nearly out or exhausted: no hop back that would fail again at once.
    expect(resolve(95)).toMatchObject({ sticky: true, selection: { instanceId: "grok" } });
    expect(resolve(100)).toMatchObject({ sticky: true, selection: { instanceId: "grok" } });
  });

  it("returns null when nothing is usable", () => {
    const providers = [claude("claudeAuto", 100), claude("claudeAutoB", 100)];
    expect(resolveAutoModelSelection({ selection: auto(), providers, now })).toBeNull();
  });
});
