import * as DateTime from "effect/DateTime";
import {
  EnvironmentId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type TipId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { TIPS } from "./catalog";
import {
  EMPTY_TIPS_STATE,
  type TipEvidence,
  type TipsState,
  addressHost,
  claimPendingSends,
  claimTipSend,
  isRemoteMachine,
  deckStartIndex,
  exposureHappenedOn,
  restoreTip,
  settleTipSend,
  voiceUseCredit,
  withTipHome,
  turnItemTipUses,
  deriveDeck,
  detectDoneTips,
  planTipsVisit,
  sameTipsState,
  tipProgress,
  updateTipProgress,
  isTipEvidenceFinal,
  launchProviderInstances,
  type TipEvidenceItem,
} from "./tipsState";

const DAY = 24 * 60 * 60 * 1000;
const START = new Date(2026, 10, 1, 12).getTime();
// A "now" just after the small fixture times, so they are not older than a week.
const SOON = 5 * 60_000;
const all = () => true;

function visit(
  state: TipsState,
  now: number,
  options: { done?: ReadonlyArray<TipId>; isAvailable?: (id: TipId) => boolean } = {},
) {
  return planTipsVisit({
    tips: TIPS,
    state,
    now,
    onboardingCompletedAt: new Date(START).toISOString(),
    done: new Map((options.done ?? []).map((id) => [id, { at: now }])),
    isAvailable: options.isAvailable ?? all,
    environmentId: "env-a",
    newEventId: () => "event-1",
  });
}

const deck = (state: TipsState, isAvailable = all) => deriveDeck(TIPS, state, isAvailable);
const completed = (result: ReturnType<typeof planTipsVisit>) =>
  result.sends.filter((send) => send.event === "completed").map((send) => send.tip);

describe("planTipsVisit", () => {
  it("introduces the sidebar and voice tips on the first day, sidebar first", () => {
    const { state } = visit(EMPTY_TIPS_STATE, START + 60_000);
    expect(deck(state)).toEqual(["boring-sidebar", "voice-input"]);
    // A second new thread the same day keeps the same strip.
    expect(deck(visit(state, START + 2 * 60 * 60 * 1000).state)).toEqual(deck(state));
  });

  it("gives a long-absent user one new tip per active day, not the backlog", () => {
    const first = visit(EMPTY_TIPS_STATE, START).state;
    const weeksLater = visit(first, START + 30 * DAY).state;
    expect(deck(weeksLater)).toEqual(["claude-codex", "boring-sidebar", "voice-input"]);
    const nextDay = visit(weeksLater, START + 31 * DAY).state;
    expect(deck(nextDay)).toEqual(["phone-app", "claude-codex", "boring-sidebar"]);
  });

  it("waits for each tip's minimum age", () => {
    const first = visit(EMPTY_TIPS_STATE, START).state;
    const dayOne = visit(first, START + DAY).state;
    const dayTwoAgain = visit(visit(dayOne, START + 1.5 * DAY).state, START + 1.6 * DAY).state;
    expect(tipProgress(dayTwoAgain, "phone-app").introducedAt).toBeUndefined();
    expect(tipProgress(dayOne, "claude-codex").introducedAt).toBe(START + DAY);
  });

  it("skips tips the user already tried or cannot use here", () => {
    const { state } = visit(EMPTY_TIPS_STATE, START + 30 * DAY, {
      done: ["boring-sidebar"],
      isAvailable: (id) => id !== "voice-input",
    });
    expect(deck(state)).toEqual(["claude-codex", "phone-app"]);
  });

  it("counts a completion only after the tip was on screen", () => {
    const shown: TipsState = {
      ...visit(EMPTY_TIPS_STATE, START).state,
      tips: { "boring-sidebar": { introducedAt: START, shownAt: START } },
    };
    const result = visit(shown, START + DAY, { done: ["boring-sidebar", "voice-input"] });
    expect(completed(result)).toEqual(["boring-sidebar"]);
    expect(deck(result.state)).not.toContain("boring-sidebar");
    const delivered = settleTipSend(result.state, "boring-sidebar", "completed", "finished");
    expect(completed(visit(delivered, START + 2 * DAY, { done: ["boring-sidebar"] }))).toEqual([]);
    // Opening the action from Settings also counts as meeting the tip.
    const opened: TipsState = { ...shown, tips: { "voice-input": { openedAt: START } } };
    expect(completed(visit(opened, START + DAY, { done: ["voice-input"] }))).toEqual([
      "voice-input",
    ]);
  });

  it.each([
    { name: "use recorded outside a visit", progress: { shownAt: 1, doneAt: 2 }, sent: true },
    { name: "use before the tip was seen", progress: { shownAt: 2, doneAt: 1 }, sent: false },
    { name: "use after hiding", progress: { shownAt: 1, dismissedAt: 1, doneAt: 2 }, sent: false },
    { name: "hiding after use", progress: { shownAt: 1, doneAt: 2, dismissedAt: 3 }, sent: true },
    {
      name: "use after opening, then hiding",
      progress: { shownAt: 1, openedAt: 1, dismissedAt: 2, doneAt: 3 },
      sent: true,
    },
    {
      name: "use after hiding, then opening from Settings",
      progress: { shownAt: 1, dismissedAt: 2, openedAt: 3, doneAt: 4 },
      sent: true,
    },
    {
      name: "use after saying not tried",
      progress: { shownAt: 1, marked: "not-tried" as const, doneAt: 2 },
      sent: false,
    },
    {
      name: "a completion already sent",
      progress: { shownAt: 1, doneAt: 2, sent: ["completed" as const] },
      sent: false,
    },
  ])("sends completed for $name: $sent", ({ progress, sent }) => {
    const state: TipsState = { ...EMPTY_TIPS_STATE, tips: { devices: progress } };
    expect(completed(visit(state, SOON))).toEqual(sent ? ["devices"] : []);
  });

  it("starts the clock at the first visit when onboarding time is missing or in the future", () => {
    for (const onboardingCompletedAt of [null, new Date(START + DAY).toISOString()]) {
      const { state } = planTipsVisit({
        tips: TIPS,
        state: EMPTY_TIPS_STATE,
        now: START,
        onboardingCompletedAt,
        done: new Map(),
        isAvailable: all,
        environmentId: null,
        newEventId: () => "event-1",
      });
      expect(state.startedAt).toBe(START);
    }
  });
});

describe("deckStartIndex", () => {
  it("starts on the oldest tip in the strip not yet seen", () => {
    const state: TipsState = {
      ...EMPTY_TIPS_STATE,
      tips: {
        "claude-codex": { introducedAt: 2 },
        "boring-sidebar": { introducedAt: 1, shownAt: 1 },
        "voice-input": { introducedAt: 1 },
      },
    };
    const strip = ["claude-codex", "boring-sidebar", "voice-input"] as const;
    expect(deckStartIndex(TIPS, strip, state)).toBe(2);
  });
});

describe("deriveDeck", () => {
  it("keeps the three newest tips that are not done or hidden", () => {
    const state: TipsState = {
      ...EMPTY_TIPS_STATE,
      tips: {
        "boring-sidebar": { introducedAt: 1 },
        "voice-input": { introducedAt: 2, dismissedAt: 5 },
        "claude-codex": { introducedAt: 3 },
        "phone-app": { introducedAt: 4 },
        "agent-threads": { introducedAt: 5 },
        "side-chats": { introducedAt: 6, doneAt: 7 },
      },
    };
    expect(deck(state)).toEqual(["agent-threads", "phone-app", "claude-codex"]);
  });

  it("lets the user's Tried it answer override detection both ways", () => {
    const state: TipsState = {
      ...EMPTY_TIPS_STATE,
      tips: {
        "boring-sidebar": { introducedAt: 1, doneAt: 2, marked: "not-tried" },
        "voice-input": { introducedAt: 2, marked: "tried" },
      },
    };
    expect(deck(state)).toEqual(["boring-sidebar"]);
  });
});

describe("send claims", () => {
  it("retries an exposure whose first send never got through", () => {
    const state: TipsState = {
      ...EMPTY_TIPS_STATE,
      tips: { devices: { shownAt: 1, openedAt: 2, seenOn: "env-a", sent: ["opened"] } },
    };
    expect(visit(state, SOON).sends).toEqual([
      { tip: "devices", event: "shown", target: "env-a", eventId: "event-1" },
    ]);
  });

  it("retries a send cut off by a closed page once its claim expires", () => {
    const state: TipsState = {
      ...EMPTY_TIPS_STATE,
      tips: {
        devices: {
          shownAt: START,
          seenOn: "env-a",
          sending: { shown: { at: START, id: "first" } },
        },
      },
    };
    expect(visit(state, START + 1_000).sends).toEqual([]);
    // The retry keeps the first id, so the server stores one copy if the first send landed.
    expect(visit(state, START + 5 * 60_000).sends).toEqual([
      { tip: "devices", event: "shown", target: "env-a", eventId: "first" },
    ]);
  });

  it("releases a rejected claim without forgetting when the user met the tip", () => {
    const shown = updateTipProgress(EMPTY_TIPS_STATE, "devices", () => ({ shownAt: 5 }));
    const claimed = claimTipSend(shown, "devices", "shown", 10, () => "event-1");
    expect(claimTipSend(claimed, "devices", "shown", 11, () => "event-2")).toBe(claimed);
    // Released for a retry that reuses the id. Only a refusal counts toward the limit.
    expect(tipProgress(settleTipSend(claimed, "devices", "shown", "refused"), "devices")).toEqual({
      shownAt: 5,
      sending: { shown: { at: 0, id: "event-1", happenedAt: 5, tries: 1 } },
    });
    const released = settleTipSend(claimed, "devices", "shown", "unreachable");
    expect(tipProgress(released, "devices")).toEqual({
      shownAt: 5,
      sending: { shown: { at: 0, id: "event-1", happenedAt: 5 } },
    });
    // A retry keeps the first claim's time, even if the stored time moved since.
    const moved = updateTipProgress(released, "devices", (p) => ({ ...p, shownAt: 2 }));
    expect(
      tipProgress(
        claimTipSend(moved, "devices", "shown", SOON, () => "event-2"),
        "devices",
      ).sending,
    ).toEqual({ shown: { at: SOON, id: "event-1", happenedAt: 5 } });
    expect(tipProgress(settleTipSend(claimed, "devices", "shown", "finished"), "devices")).toEqual({
      shownAt: 5,
      sent: ["shown"],
    });
  });

  it.each([
    { name: "on the environment that showed it", doneOn: "env-a", target: "env-a" },
    { name: "with no environment, such as a setting", doneOn: undefined, target: "env-a" },
  ])("sends a completion for use $name", ({ doneOn, target }) => {
    const state: TipsState = {
      ...EMPTY_TIPS_STATE,
      tips: {
        devices: {
          shownAt: 1,
          seenOn: "env-a",
          sent: ["shown"],
          doneAt: 2,
          ...(doneOn === undefined ? {} : { doneOn }),
        },
      },
    };
    expect(visit(state, SOON).sends).toEqual([
      { tip: "devices", event: "completed", target, eventId: "event-1" },
    ]);
  });

  it("gives up on an event after three refused sends", () => {
    const refused = (tries: number): TipsState => ({
      ...EMPTY_TIPS_STATE,
      tips: {
        devices: { shownAt: 1, seenOn: "env-a", sending: { shown: { at: 0, id: "e", tries } } },
      },
    });
    expect(visit(refused(2), SOON).sends).toHaveLength(1);
    const result = visit(refused(3), SOON);
    expect(result.sends).toEqual([]);
    expect(tipProgress(result.state, "devices").sent).toEqual(["shown"]);
  });

  it.each([
    { name: "a first view here", progress: {}, field: "shownAt" as const, expected: "env-b" },
    {
      name: "a repeat view, where the first one was",
      progress: { shownAt: 1, seenOn: "env-a" },
      field: "shownAt" as const,
      expected: "env-a",
    },
    {
      name: "a repeat open, where the first open was",
      progress: { openedAt: 1, seenOn: "env-a", openedOn: "env-c" },
      field: "openedAt" as const,
      expected: "env-c",
    },
  ])("places $name", ({ progress, field, expected }) => {
    expect(exposureHappenedOn(progress, field, "env-b")).toBe(expected);
  });

  it("does not credit use while a tip was hidden when it is restored", () => {
    const hiddenUse = (openedAt?: number): TipsState => ({
      ...EMPTY_TIPS_STATE,
      tips: {
        devices: {
          shownAt: 1,
          dismissedAt: 2,
          doneAt: 3,
          ...(openedAt === undefined ? {} : { openedAt }),
        },
      },
    });
    expect(tipProgress(restoreTip(hiddenUse(), "devices", 4), "devices").sent).toEqual([
      "completed",
    ]);
    // Opening the tip before the use still counts.
    expect(tipProgress(restoreTip(hiddenUse(2.5), "devices", 4), "devices").sent).toBeUndefined();
    // A second tab restoring a tip already restored changes nothing.
    const restored = restoreTip(hiddenUse(), "devices", 4);
    expect(restoreTip(restored, "devices", 5)).toBe(restored);
  });

  it.each([
    { name: "on the draft's server", transcribedOn: "env-a", expected: { on: "env-a" } },
    { name: "on another server", transcribedOn: "env-b", expected: "unreported" },
    { name: "with no server", transcribedOn: null, expected: "unreported" },
  ])("credits a transcript made $name", ({ transcribedOn, expected }) => {
    expect(voiceUseCredit(transcribedOn, "env-a")).toEqual(expected);
  });

  it("judges late evidence against every hidden span in the past week", () => {
    const completions = (state: TipsState, doneAt: number) =>
      claimPendingSends({
        tips: TIPS,
        state: updateTipProgress(state, "phone-app", (p) => ({ ...p, doneAt })),
        now: SOON,
        environmentId: "env-a",
        newEventId: () => "e",
      }).sends.filter((send) => send.event === "completed");
    const seen: TipsState = {
      ...EMPTY_TIPS_STATE,
      tips: { "phone-app": { shownAt: 1, seenOn: "env-a", sent: ["shown"] } },
    };
    // Hidden 2-4, then 6-8. A phone thread made at 3 is seen only after both restores.
    const hide = (state: TipsState, at: number) =>
      updateTipProgress(state, "phone-app", (p) => ({ ...p, dismissedAt: at }));
    const twice = restoreTip(hide(restoreTip(hide(seen, 2), "phone-app", 4), 6), "phone-app", 8);
    expect(completions(twice, 3)).toEqual([]);
    expect(completions(twice, 7)).toEqual([]);
    // Use between the spans counts, which shows the spans, not age, decide.
    expect(completions(twice, 5)).toHaveLength(1);
  });

  it("does not send an event too old to date truly", () => {
    const state: TipsState = {
      ...EMPTY_TIPS_STATE,
      tips: { devices: { shownAt: START - 8 * DAY, seenOn: "env-a" } },
    };
    const result = visit(state, START);
    expect(result.sends).toEqual([]);
    expect(tipProgress(result.state, "devices").sent).toEqual(["shown"]);
  });

  it("ages a retry by its first claim's time, not by evidence that loaded later", () => {
    const state: TipsState = {
      ...EMPTY_TIPS_STATE,
      tips: {
        devices: {
          shownAt: START - 10 * DAY,
          seenOn: "env-a",
          sent: ["shown"],
          // Older evidence moved the use back after the first claim, which was offline.
          doneAt: START - 8 * DAY,
          sending: { completed: { at: 0, id: "first", happenedAt: START - DAY } },
        },
      },
    };
    const result = claimPendingSends({
      tips: TIPS,
      state,
      now: START,
      environmentId: "env-a",
      newEventId: () => "second",
    });
    expect(result.sends).toEqual([
      { tip: "devices", event: "completed", target: "env-a", eventId: "first" },
    ]);
  });

  it("does not let a view on another environment earn its home server a completion", () => {
    const state = (shownOn: string): TipsState => ({
      ...EMPTY_TIPS_STATE,
      tips: {
        devices: {
          shownAt: 1,
          shownOn,
          seenOn: "env-a",
          sent: ["shown"],
          doneAt: 2,
          doneOn: "env-a",
        },
      },
    });
    const completed = (shownOn: string) =>
      visit(state(shownOn), SOON).sends.filter((send) => send.event === "completed");
    expect(completed("env-a")).toHaveLength(1);
    expect(completed("env-b")).toEqual([]);
  });

  it("does not let an open on another environment excuse use while hidden", () => {
    const state = (openedOn: string): TipsState => ({
      ...EMPTY_TIPS_STATE,
      tips: {
        devices: {
          shownAt: 1,
          seenOn: "env-a",
          sent: ["shown", "opened"],
          dismissedAt: 2,
          openedAt: 3,
          openedOn,
          doneAt: 4,
          doneOn: "env-a",
        },
      },
    });
    const completed = (openedOn: string) =>
      visit(state(openedOn), SOON).sends.filter((send) => send.event === "completed");
    expect(completed("env-a")).toHaveLength(1);
    expect(completed("env-b")).toEqual([]);
  });

  it("keeps a tip's first home", () => {
    expect(withTipHome({}, "env-a").seenOn).toBe("env-a");
    expect(withTipHome({ seenOn: "env-b" }, "env-a").seenOn).toBe("env-b");
  });

  it("makes the first environment a tip's events go to its home, so they never split", () => {
    const state: TipsState = { ...EMPTY_TIPS_STATE, tips: { devices: { openedAt: 1 } } };
    const result = visit(state, SOON);
    expect(result.sends).toEqual([
      { tip: "devices", event: "opened", target: "env-a", eventId: "event-1" },
    ]);
    expect(tipProgress(result.state, "devices").seenOn).toBe("env-a");
  });

  it("never reports use on another environment, so that server's opt-out holds", () => {
    const state: TipsState = {
      ...EMPTY_TIPS_STATE,
      tips: {
        devices: { shownAt: 1, seenOn: "env-a", sent: ["shown"], doneAt: 2, doneOn: "env-b" },
      },
    };
    const result = visit(state, SOON);
    expect(result.sends).toEqual([]);
    expect(tipProgress(result.state, "devices").sent).toEqual(["shown", "completed"]);
  });

  it("compares stored state by value, not by key order", () => {
    const a: TipsState = { ...EMPTY_TIPS_STATE, tips: { devices: { doneAt: 2, shownAt: 1 } } };
    const b: TipsState = { ...EMPTY_TIPS_STATE, tips: { devices: { shownAt: 1, doneAt: 2 } } };
    expect(sameTipsState(a, b)).toBe(true);
  });
});

describe("detectDoneTips", () => {
  const environmentId = EnvironmentId.make("env-1");
  const claude = ProviderInstanceId.make("claudeAgent");
  const codex = ProviderInstanceId.make("codex");
  const grok = ProviderInstanceId.make("grok");
  const drivers = new Map<string, ProviderDriverKind>([
    [grok, ProviderDriverKind.make("grok")],
    [claude, ProviderDriverKind.make("claudeAgent")],
    [codex, ProviderDriverKind.make("codex")],
  ]);
  const shell = (
    id: string,
    providerInstanceId: ProviderInstanceId,
    fields: {
      parent?: string;
      fork?: boolean;
      environment?: string;
      delegatedFrom?: { environment: string; thread: string };
      history?: ReadonlyArray<ProviderInstanceId>;
      sideChat?: boolean;
      ran?: boolean;
      createdBy?: "user" | "agent";
      creationSource?: "web" | "mobile" | "mcp" | "provider";
    } = {},
  ): TipEvidence["shells"][number] =>
    ({
      environmentId:
        fields.environment === undefined ? environmentId : EnvironmentId.make(fields.environment),
      id: ThreadId.make(id),
      delegatedFrom:
        fields.delegatedFrom === undefined
          ? null
          : {
              environmentId: EnvironmentId.make(fields.delegatedFrom.environment),
              threadId: ThreadId.make(fields.delegatedFrom.thread),
              title: "Parent",
            },
      providerInstanceId,
      lineage: {
        parentThreadId: fields.parent === undefined ? null : ThreadId.make(fields.parent),
        relationshipToParent:
          fields.parent === undefined ? null : fields.fork === true ? "fork" : "subagent",
        rootThreadId: ThreadId.make(fields.parent ?? id),
        ...(fields.sideChat ? { sideChat: true } : {}),
      },
      createdAt: "2026-01-01T00:00:00.000Z",
      latestRun: fields.ran === false ? null : { runId: "run" },
      providerInstanceHistory: fields.history ?? [providerInstanceId],
      source: {
        createdBy: fields.createdBy ?? "user",
        creationSource: fields.creationSource ?? "web",
      },
    }) as TipEvidence["shells"][number];
  const detect = (shells: TipEvidence["shells"]) =>
    [
      ...detectDoneTips({
        now: 0,
        boringSidebarEnabled: false,
        remoteEnvironmentCount: 0,
        shells,
        driverOf: (_environmentId, instanceId) => drivers.get(instanceId),
      }).keys(),
    ].toSorted();

  it.each([
    {
      name: "a Codex thread an agent started from a Claude thread",
      shells: [
        shell("parent", claude),
        shell("child", codex, { parent: "parent", createdBy: "agent", creationSource: "mcp" }),
      ],
      expected: ["agent-threads", "claude-codex"],
    },
    {
      name: "a Codex thread delegated from a Claude thread on another computer",
      shells: [
        shell("parent", claude, { environment: "env-2" }),
        shell("child", codex, {
          createdBy: "agent",
          creationSource: "mcp",
          delegatedFrom: { environment: "env-2", thread: "parent" },
        }),
      ],
      expected: ["agent-threads", "claude-codex"],
    },
    {
      name: "a Codex thread started by a thread that Claude delegated to another provider",
      shells: [
        shell("parent", claude),
        shell("grok", grok, {
          environment: "env-2",
          createdBy: "agent",
          creationSource: "mcp",
          delegatedFrom: { environment: "env-1", thread: "parent" },
        }),
        // The child inherits `delegatedFrom`, but its own parent is the Grok thread.
        shell("child", codex, {
          environment: "env-2",
          parent: "grok",
          createdBy: "agent",
          creationSource: "mcp",
          delegatedFrom: { environment: "env-1", thread: "parent" },
        }),
      ],
      expected: ["agent-threads"],
    },
    {
      name: "a Claude thread an agent started from a Codex thread",
      shells: [
        shell("parent", codex),
        shell("child", claude, { parent: "parent", createdBy: "agent", creationSource: "mcp" }),
      ],
      expected: ["agent-threads"],
    },
    {
      name: "a Codex thread started from a thread switched to Claude later",
      shells: [
        shell("parent", claude, { history: [codex] }),
        shell("child", codex, { parent: "parent", createdBy: "agent", creationSource: "mcp" }),
      ],
      expected: ["agent-threads"],
    },
    {
      name: "a Codex child from an older server that sends no history",
      shells: [
        shell("parent", claude),
        shell("child", codex, {
          parent: "parent",
          createdBy: "agent",
          creationSource: "mcp",
          history: [],
        }),
      ],
      expected: ["agent-threads"],
    },
    {
      name: "a fork an outside MCP app made",
      shells: [
        shell("parent", claude),
        shell("child", codex, {
          parent: "parent",
          fork: true,
          createdBy: "agent",
          creationSource: "mcp",
        }),
      ],
      expected: [],
    },
    {
      name: "a parentless thread an outside MCP app started",
      shells: [shell("outside", codex, { createdBy: "agent", creationSource: "mcp" })],
      expected: [],
    },
    {
      name: "a provider-native subagent",
      shells: [
        shell("parent", claude),
        shell("child", codex, { parent: "parent", createdBy: "agent", creationSource: "provider" }),
      ],
      expected: [],
    },
    {
      name: "a side chat started from the phone",
      shells: [shell("side", claude, { parent: "main", sideChat: true, creationSource: "mobile" })],
      expected: ["phone-app", "side-chats"],
    },
    {
      name: "an empty side chat",
      shells: [shell("side", claude, { parent: "main", sideChat: true, ran: false })],
      expected: [],
    },
  ])("detects $name", ({ shells, expected }) => {
    expect(detect(shells)).toEqual(expected);
  });

  it("dates thread evidence by when the thread was created, not when it was seen", () => {
    const done = detectDoneTips({
      now: Date.parse("2026-06-01T00:00:00.000Z"),
      boringSidebarEnabled: true,
      remoteEnvironmentCount: 0,
      shells: [shell("phone", claude, { creationSource: "mobile" })],
      driverOf: (_environmentId, instanceId) => drivers.get(instanceId),
    });
    expect(done.get("phone-app")).toEqual({
      at: Date.parse("2026-01-01T00:00:00.000Z"),
      on: environmentId,
    });
    expect(done.get("boring-sidebar")).toEqual({
      at: Date.parse("2026-06-01T00:00:00.000Z"),
      on: undefined,
    });
  });
});

describe("isRemoteMachine", () => {
  it.each([
    {
      name: "a server on another host",
      kind: "other",
      host: "box.tail.ts.net",
      desktopApp: true,
      remote: true,
    },
    { name: "a relay environment", kind: "other", host: null, desktopApp: true, remote: true },
    {
      name: "an SSH host on loopback",
      kind: "other",
      host: addressHost("theo@localhost:22"),
      desktopApp: true,
      remote: false,
    },
    {
      name: "an SSH host on IPv6 loopback",
      kind: "other",
      host: addressHost("theo@::1"),
      desktopApp: true,
      remote: false,
    },
    {
      name: "a bare host and port on loopback",
      kind: "other",
      host: addressHost("localhost:3773"),
      desktopApp: true,
      remote: false,
    },
    {
      name: "a server on 127.0.0.2",
      kind: "other",
      host: addressHost("http://127.0.0.2:3773"),
      desktopApp: false,
      remote: false,
    },
    {
      name: "this desktop's WSL backend",
      kind: "desktop-local",
      host: "localhost",
      desktopApp: true,
      remote: false,
    },
    {
      name: "the desktop app's own primary",
      kind: "primary",
      host: "172.20.0.2",
      desktopApp: true,
      remote: false,
    },
    {
      name: "a web page served from another machine",
      kind: "primary",
      host: "box.local",
      desktopApp: false,
      remote: true,
    },
  ] as const)("treats $name as remote: $remote", ({ kind, host, desktopApp, remote }) => {
    expect(isRemoteMachine({ kind, host, desktopApp })).toBe(remote);
  });
});

describe("turnItemTipUses", () => {
  const environmentId = EnvironmentId.make("env-1");
  const claude = ProviderInstanceId.make("claudeAgent");
  const driverOf = (_environmentId: string, instanceId: string) =>
    instanceId === claude
      ? ProviderDriverKind.make("claudeAgent")
      : ProviderDriverKind.make("codex");
  const codexInstance = ProviderInstanceId.make("codex");
  const claudeParent = { environmentId, providerInstanceId: claude, providerInstanceHistory: [] };
  const startedAt = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
  const subagent = (fields: Record<string, unknown>) =>
    ({
      type: "subagent",
      threadId: ThreadId.make("parent"),
      startedAt,
      updatedAt: startedAt,
      origin: "app_owned",
      driver: "codex",
      childThreadId: null,
      subagentId: "spawn",
      ...fields,
    }) as unknown as TipEvidenceItem;
  // The loaded child of a launch card, as the client sees it while the task runs.
  const spawnedChild = {
    environmentId,
    providerInstanceHistory: [codexInstance],
    forkedFrom: { type: "node" as const, nodeId: NodeId.make("spawn") },
  };
  const uses = (item: TipEvidenceItem) =>
    turnItemTipUses(
      environmentId,
      item,
      {
        parent: claudeParent,
        child: item.type === "subagent" && item.childThreadId !== null ? spawnedChild : null,
        runs: [],
      },
      driverOf,
    ).map(([id]) => id);

  it.each([
    {
      name: "a Codex task with its own thread",
      item: subagent({ childThreadId: ThreadId.make("child") }),
      expected: ["agent-threads", "claude-codex"],
    },
    {
      name: "a Codex task on another computer",
      item: subagent({ remoteChild: { environmentId: "env-2" } }),
      expected: ["agent-threads", "claude-codex"],
    },
    {
      name: "a Codex thread a Claude thread created, which may never run",
      item: {
        type: "thread_created",
        threadId: ThreadId.make("parent"),
        startedAt,
        updatedAt: startedAt,
        targetThreadId: ThreadId.make("child"),
        targetProviderInstanceId: codexInstance,
      } as unknown as TipEvidenceItem,
      expected: ["agent-threads"],
    },
    {
      name: "a provider's own subagent",
      item: subagent({ origin: "provider_native" }),
      expected: [],
    },
  ])("records $name", ({ item, expected }) => {
    expect(uses(item)).toEqual(expected);
  });

  it("uses the child's first provider, so a child switched to Codex later does not count", () => {
    const item = subagent({ childThreadId: ThreadId.make("child") });
    const child = { providerInstanceHistory: [claude] };
    expect(
      turnItemTipUses(
        environmentId,
        item,
        { parent: claudeParent, child: { ...child, environmentId, forkedFrom: null }, runs: [] },
        driverOf,
      ).map(([id]) => id),
    ).toEqual(["agent-threads"]);
  });

  it("does not count a reply to an existing child as a launch", () => {
    const child = {
      environmentId,
      providerInstanceHistory: [codexInstance],
      forkedFrom: { type: "node" as const, nodeId: NodeId.make("spawn") },
    };
    const uses = (subagentId: string) =>
      turnItemTipUses(
        environmentId,
        subagent({ childThreadId: ThreadId.make("child"), subagentId }),
        { parent: claudeParent, child, runs: [] },
        driverOf,
      ).map(([id]) => id);
    expect(uses("spawn")).toEqual(["agent-threads", "claude-codex"]);
    expect(uses("follow-up")).toEqual([]);
    // Without the child loaded, a card cannot be told from a reply, so it earns nothing.
    expect(
      turnItemTipUses(
        environmentId,
        subagent({ childThreadId: ThreadId.make("child"), subagentId: "follow-up" }),
        { parent: claudeParent, child: null, runs: [] },
        driverOf,
      ).map(([id]) => id),
    ).toEqual([]);
  });

  it("trusts the run that started the child over the parent's history", () => {
    const codexThenClaude = { ...claudeParent, providerInstanceHistory: [codexInstance, claude] };
    const item = subagent({ childThreadId: ThreadId.make("child"), runId: "run-2" });
    const uses = (runs: ReadonlyArray<{ id: string; providerInstanceId: string }>) =>
      turnItemTipUses(
        environmentId,
        item,
        { parent: codexThenClaude, child: spawnedChild, runs },
        driverOf,
      ).map(([id]) => id);
    expect(uses([{ id: "run-2", providerInstanceId: claude }])).toEqual([
      "agent-threads",
      "claude-codex",
    ]);
    // Without the run, a parent that once ran on Codex is not trusted.
    expect(uses([])).toEqual(["agent-threads"]);
  });

  // Outputs as the wire sends them: a summary of ids and `isError`, with `outputOmitted` set.
  it.each([
    {
      name: "a completed t3_thread_launch",
      toolName: "mcp__t3-code__t3_thread_launch",
      status: "completed",
      output: { threadId: "child" },
      expected: ["agent-threads"],
    },
    {
      name: "a failed t3_thread_launch",
      toolName: "mcp__t3-code__t3_thread_launch",
      status: "failed",
      output: { threadId: "child" },
      expected: [],
    },
    {
      name: "a t3_thread_launch that completed with an MCP error",
      toolName: "mcp__t3-code__t3_thread_launch",
      status: "completed",
      output: { isError: true },
      expected: [],
    },
    {
      name: "a t3_thread_launch that names no thread",
      toolName: "mcp__t3-code__t3_thread_launch",
      status: "completed",
      output: null,
      expected: [],
    },
    {
      name: "a create_threads call that was rolled back",
      toolName: "mcp__t3-code__create_threads",
      status: "completed",
      output: { threads: [{ threadId: "child", status: "rolled_back" }] },
      expected: [],
    },
    {
      name: "another tool",
      toolName: "mcp__t3-code__t3_thread_read",
      status: "completed",
      output: { threadId: "child" },
      expected: [],
    },
  ])("records $name", ({ toolName, status, output, expected }) => {
    const item = {
      type: "dynamic_tool",
      output,
      outputOmitted: output === null ? undefined : true,
      threadId: ThreadId.make("parent"),
      startedAt,
      updatedAt: startedAt,
      status,
      toolName,
      input: {},
    } as unknown as TipEvidenceItem;
    expect(
      turnItemTipUses(environmentId, item, { parent: null, child: null, runs: [] }, driverOf).map(
        ([id]) => id,
      ),
    ).toEqual(expected);
  });

  it.each([
    {
      name: "the starter run's instance, not the parent's history",
      input: { run: { providerInstanceId: "claude-work" }, parent: claudeParent, child: null },
      expected: [[environmentId, "claude-work"]],
    },
    {
      name: "every instance the parent used when the run is unknown",
      input: {
        run: undefined,
        parent: { providerInstanceId: claude, providerInstanceHistory: [codexInstance] },
        child: null,
      },
      expected: [
        [environmentId, claude],
        [environmentId, codexInstance],
      ],
    },
    {
      name: "the child's first instance on its own machine",
      input: {
        run: { providerInstanceId: claude },
        parent: null,
        child: {
          environmentId: EnvironmentId.make("env-2"),
          providerInstanceHistory: [codexInstance, claude],
        },
      },
      expected: [
        [environmentId, claude],
        ["env-2", codexInstance],
      ],
    },
  ])("waits on $name", ({ input, expected }) => {
    expect(launchProviderInstances(environmentId, input)).toEqual(expected);
  });

  it.each([
    { name: "a running tool", item: { type: "dynamic_tool", status: "running" }, final: false },
    { name: "a finished tool", item: { type: "dynamic_tool", status: "completed" }, final: true },
    { name: "a created thread", item: { type: "thread_created" }, loaded: {}, final: true },
    { name: "a card before its parent loads", loaded: { parent: false }, final: false },
    { name: "a card before providers load", loaded: { providers: false }, final: false },
    { name: "a card before its child loads", loaded: { child: false }, final: false },
    { name: "a card whose child cannot load", loaded: { child: null }, final: true },
    {
      name: "a finished card whose child is not loaded",
      item: { type: "subagent", status: "completed" },
      loaded: { child: false },
      final: true,
    },
    {
      name: "a finished card before providers load",
      item: { type: "subagent", status: "completed" },
      loaded: { child: false, providers: false },
      final: false,
    },
    { name: "a card with everything loaded", final: true },
  ])("treats $name as final: $final", ({ item, loaded, final }) => {
    expect(
      isTipEvidenceFinal(
        (item ?? { type: "subagent", status: "running" }) as unknown as TipEvidenceItem,
        {
          parent: true,
          child: true,
          providers: true,
          ...loaded,
        },
      ),
    ).toBe(final);
  });

  it("dates the use by when the item started", () => {
    const [[, use] = []] = turnItemTipUses(
      environmentId,
      subagent({ childThreadId: ThreadId.make("child") }),
      { parent: claudeParent, child: spawnedChild, runs: [] },
      driverOf,
    );
    expect(use).toEqual({ at: DateTime.toEpochMillis(startedAt), on: environmentId });
  });
});
