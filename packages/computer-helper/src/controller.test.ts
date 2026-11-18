// Ported from LocalRouter (github.com/jayleaton/localrouter @fe24726, apps/desktop-helper/src/computer/controller.test.ts), modified for Ada.
// LocalRouter ported it from Sidebud (github.com/jayleaton/sidebud @70da540); both notices ship in LICENSE.localrouter.
import { describe, expect, it, vi } from "vite-plus/test";
import { silentLogger } from "./log.ts";
import {
  ComputerUse,
  ComputerUseRuns,
  navigationText,
  navigationUnmet,
  pureNavigation,
  quotedTargets,
  resolveTab,
  settled,
  siteNamed,
  soundKey,
  unquotedTabName,
} from "./controller.ts";
import type {
  Authorize,
  AuthorizeRequest,
  ComputerTask,
  Deps,
  Grant,
  RunOptions,
  Session,
} from "./controller.ts";
import type { Answer, Answers, Question } from "./decisions.ts";
import { FakeNotes } from "./fake.ts";
import { NeedsPointer } from "./types.ts";
import type {
  BrowserTab,
  BrowserTabs,
  Observation,
  ScreenAction,
  ScreenBackend,
  ScreenControl,
} from "./types.ts";

const choice = (value: string, probability = 0.9): Answer => ({
  type: "choice",
  choice: value,
  probability,
});
const control = (
  ref: string,
  role: ScreenControl["role"],
  label: string,
  extra: Partial<ScreenControl> = {},
): ScreenControl => ({ ref, role, label, ...extra });
const ALLOW: Grant = { ok: true, grant: "allow" };

/** A server that grants everything at once, recording what it was asked. */
function allowAll() {
  const requests: AuthorizeRequest[] = [];
  const authorize = vi.fn(async (request: AuthorizeRequest): Promise<Grant> => {
    requests.push(request);
    return ALLOW;
  });
  return { authorize, requests };
}

/** A decider that answers from a script, recording every question set it was asked. */
function scripted(replies: Answers[]) {
  const asked: Array<{ state: unknown; questions: Record<string, Question> }> = [];
  const decider = {
    ask: vi.fn(async (state: unknown, questions: Record<string, Question>) => {
      asked.push({ state, questions });
      const answers = replies.shift();
      if (!answers) throw new Error("no reply scripted");
      return answers;
    }),
  };
  return { decider, asked };
}

/** Chrome with a Skool tab among others, as on the owner's Mac on 2026-09-26. */
const TABS: BrowserTab[] = [
  {
    window: 0,
    index: 0,
    title: "Search results - Gmail",
    url: "https://mail.google.com/mail/u/3/",
    active: true,
  },
  {
    window: 0,
    index: 4,
    title: "Early AI-dopters",
    url: "https://www.skool.com/earlyaidopters",
    active: false,
  },
];

/** A scripted page: each observation follows the previous action, like a real Skool session. */
function skool() {
  const screens: Observation[] = [
    {
      backend: "browser",
      app: "Google Chrome",
      title: "Early AI-dopters",
      url: "https://www.skool.com/earlyaidopters",
      controls: [
        control("s1", "link", "Community"),
        control("s2", "button", "Messages"),
        control("s3", "button", "Notifications"),
      ],
    },
    {
      backend: "browser",
      app: "Google Chrome",
      title: "Messages",
      controls: [control("s1", "row", "Mark Kashef"), control("s2", "row", "Dana Lee")],
    },
    {
      backend: "browser",
      app: "Google Chrome",
      title: "Mark Kashef",
      controls: [
        control("s1", "textbox", "Type a message", { focused: true }),
        control("s2", "button", "Send"),
      ],
    },
    {
      backend: "browser",
      app: "Google Chrome",
      title: "Mark Kashef",
      controls: [
        control("s1", "textbox", "Type a message", {
          value: "GitHub billing is not set up…",
          focused: true,
        }),
        control("s2", "button", "Send"),
      ],
    },
    {
      backend: "browser",
      app: "Google Chrome",
      title: "Mark Kashef",
      text: "GitHub billing is not set up, and CI has run out of usage.",
      controls: [
        control("s1", "textbox", "Type a message", { focused: true }),
        control("s2", "button", "Send"),
      ],
    },
  ];
  const actions: ScreenAction[] = [];
  const state = { at: 0 };
  const page: ScreenBackend = {
    kind: "browser",
    observe: async () => screens[Math.min(state.at, screens.length - 1)]!,
    act: async (action) => {
      actions.push(action);
      state.at += 1;
    },
  };
  const activated: BrowserTab[] = [];
  const tabs: BrowserTabs = {
    browser: "Google Chrome",
    list: async () => TABS,
    activate: async (tab) => void activated.push(tab),
  };
  return { page, tabs, actions, activated, state };
}

/** Time that passes only when the run waits, so a wait for a page never spins on the wall clock. */
function fakeClock() {
  let now = 0;
  return {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
  };
}

function computerWith(
  replies: Answers[],
  parts: { page: ScreenBackend; tabs: BrowserTabs | null },
  authorize: Authorize = allowAll().authorize,
  extra: Partial<Deps> = {},
) {
  const { decider, asked } = scripted(replies);
  const computer = new ComputerUse({
    decider,
    authorize,
    tabs: parts.tabs,
    desktop: parts.page,
    dock: null,
    apps: null,
    log: silentLogger,
    settleMs: 0,
    ...fakeClock(),
    ...extra,
  });
  return { computer, asked };
}

const TASK: ComputerTask = {
  goal: "In the Skool tab in Chrome, open Messages, find Mark, and send him a note that GitHub billing is not set up and CI has run out of usage.",
  text: "GitHub billing is not set up, and CI has run out of usage.",
};

const SKOOL_REPLIES = (): Answers[] => [
  { surface: choice("browser"), tab: choice("t1") },
  { next: choice("c1") },
  { next: choice("c0") },
  { next: choice("type_text"), type_into: choice("c0") },
  { next: choice("press_enter") },
  { next: choice("done") },
];

describe("ComputerUse", () => {
  it("opens the Skool tab, finds Mark in Messages, types the note, and sends it, each action granted by the server first", async () => {
    const parts = skool();
    const box = allowAll();
    const steps: string[] = [];
    const { computer, asked } = computerWith(SKOOL_REPLIES(), parts, box.authorize, {
      onStep: (step) => void steps.push(step),
    });
    const outcome = await computer.run(TASK);
    expect(outcome).toMatchObject({ status: "done", surface: "Google Chrome: Mark Kashef" });
    expect(parts.activated).toEqual([TABS[1]]);
    expect(parts.actions).toEqual([
      { kind: "click", ref: "s2" },
      { kind: "click", ref: "s1" },
      { kind: "type", ref: "s1", text: TASK.text },
      { kind: "press", key: "enter" },
    ]);
    // Every action, the tab switch included, was asked for exactly as it then happened.
    expect(box.requests.map((request) => request.action)).toEqual([
      { kind: "surface", what: "tab", name: "Early AI-dopters" },
      { kind: "click", ref: "s2", role: "button", label: "Messages" },
      { kind: "click", ref: "s1", role: "row", label: "Mark Kashef" },
      { kind: "type", ref: "s1", role: "textbox", label: "Type a message", text: TASK.text },
      { kind: "press", key: "enter", field: { role: "textbox", label: "Type a message" } },
    ]);
    expect(box.requests.map((request) => request.step)).toEqual([1, 2, 3, 4, 5]);
    expect(box.requests[1]!.observation).toEqual({
      app: "Google Chrome",
      title: "Early AI-dopters",
      url: "https://www.skool.com/earlyaidopters",
    });
    // Each step chooses among the controls the screen actually has.
    expect(asked[1]!.questions.next).toMatchObject({
      criteria: {
        c1: "Click the button “Messages”",
        scroll_down: expect.any(String),
        stuck: expect.any(String),
      },
    });
    expect(asked[0]!.questions.tab).toMatchObject({
      criteria: { t1: "Early AI-dopters (www.skool.com)" },
    });
    expect(steps[1]).toBe("clicked the button “Messages”");
    expect(steps).toHaveLength(5);
    // The text to type reaches the server only as the type action's own binding, even when the page echoes it back.
    const typeRequest = box.requests.findIndex((request) => request.action.kind === "type");
    const elsewhere = [
      asked,
      outcome,
      steps,
      box.requests.filter((_, index) => index !== typeRequest),
    ];
    expect(JSON.stringify(elsewhere)).not.toContain(TASK.text!);
    expect(JSON.stringify(asked.at(-1)!.state)).toContain("[typed text]");
  });

  it("stops before sending when the server denies the Enter that sends, and says why", async () => {
    const parts = skool();
    const requests: AuthorizeRequest[] = [];
    const authorize = vi.fn(async (request: AuthorizeRequest): Promise<Grant> => {
      requests.push(request);
      return request.action.kind === "press"
        ? { ok: false, denied: "You did not approve sending that." }
        : ALLOW;
    });
    const { computer } = computerWith(SKOOL_REPLIES(), parts, authorize);
    const outcome = await computer.run(TASK);
    expect(outcome).toMatchObject({
      status: "blocked",
      reason: "You did not approve sending that.",
    });
    expect(parts.actions.map((action) => action.kind)).toEqual(["click", "click", "type"]);
  });

  it("sends after the user approves the Enter on screen, and the wait does not count as working time", async () => {
    const parts = skool();
    let clock = 0;
    const authorize = vi.fn(async (request: AuthorizeRequest): Promise<Grant> => {
      if (request.action.kind !== "press") return ALLOW;
      clock += 55_000;
      return { ok: true, grant: "approved" };
    });
    const { computer } = computerWith(SKOOL_REPLIES(), parts, authorize, { now: () => clock });
    const outcome = await computer.run(TASK, { limits: { timeoutMs: 10_000 } });
    expect(outcome).toMatchObject({ status: "done" });
    expect(parts.actions.at(-1)).toEqual({ kind: "press", key: "enter" });
  });

  it("never types text the request did not carry, and stops when no step is clearly right", async () => {
    const parts = skool();
    const { computer, asked } = computerWith(
      [{ surface: choice("browser"), tab: choice("t1") }, { next: choice("c1", 0.4) }],
      parts,
    );
    expect(await computer.run({ ...TASK, text: null })).toMatchObject({ status: "stuck" });
    expect(asked[1]!.questions.next).not.toHaveProperty("criteria.type_text");
    expect(parts.actions).toEqual([]);
  });

  describe("authority: nothing happens without a grant", () => {
    it("acts only after the server grants that exact action", async () => {
      const parts = skool();
      const seen: AuthorizeRequest[] = [];
      const pending: Array<(grant: Grant) => void> = [];
      const authorize = vi.fn((request: AuthorizeRequest) => {
        seen.push(request);
        return new Promise<Grant>((resolve) => void pending.push(resolve));
      });
      const { computer } = computerWith(
        [
          { surface: choice("browser"), tab: choice("t1") },
          { next: choice("c1") },
          { next: choice("done") },
        ],
        parts,
        authorize,
      );
      const outcome = computer.run(TASK);
      await vi.waitFor(() => expect(seen).toHaveLength(1));
      expect(parts.activated).toEqual([]);
      pending[0]!(ALLOW);
      await vi.waitFor(() => expect(seen).toHaveLength(2));
      expect(seen[1]!.action).toEqual({
        kind: "click",
        ref: "s2",
        role: "button",
        label: "Messages",
      });
      expect(parts.actions).toEqual([]);
      pending[1]!(ALLOW);
      expect(await outcome).toMatchObject({ status: "done" });
      expect(parts.actions).toEqual([{ kind: "click", ref: "s2" }]);
    });

    it("ends stuck without acting when the server refuses the request itself (past its limits)", async () => {
      const parts = skool();
      const authorize = vi.fn(async (request: AuthorizeRequest): Promise<Grant> => {
        if (request.action.kind === "surface") return ALLOW;
        throw new Error("past max_steps");
      });
      const { computer } = computerWith(
        [{ surface: choice("browser"), tab: choice("t1") }, { next: choice("c1") }],
        parts,
        authorize,
      );
      expect(await computer.run(TASK)).toMatchObject({
        status: "stuck",
        reason: expect.stringContaining("past max_steps"),
      });
      expect(parts.actions).toEqual([]);
    });

    it("does not bring a tab forward when the server denies the switch", async () => {
      const parts = skool();
      const authorize = vi.fn(async (): Promise<Grant> => ({ ok: false, denied: "Not now." }));
      const { computer } = computerWith(
        [{ surface: choice("browser"), tab: choice("t1") }],
        parts,
        authorize,
      );
      expect(await computer.run(TASK)).toMatchObject({ status: "blocked", reason: "Not now." });
      expect(parts.activated).toEqual([]);
    });

    it("does not act on a control that changed while it waited for the tap", async () => {
      const parts = skool();
      const authorize = vi.fn(async (request: AuthorizeRequest): Promise<Grant> => {
        if (request.action.kind === "surface") return ALLOW;
        // The page moves on while the user decides: Messages is gone.
        parts.state.at = 1;
        return { ok: true, grant: "approved" };
      });
      const { computer } = computerWith(
        [{ surface: choice("browser"), tab: choice("t1") }, { next: choice("c1") }],
        parts,
        authorize,
      );
      expect(await computer.run(TASK)).toMatchObject({
        status: "stuck",
        reason: "The screen changed while it waited for your OK, so it did not act.",
      });
      expect(parts.actions).toEqual([]);
    });
  });

  describe("closed candidate sets", () => {
    it("stops on an answer key it did not offer, without acting", async () => {
      const parts = skool();
      const { computer } = computerWith(
        [{ surface: choice("browser"), tab: choice("t1") }, { next: choice("c99") }],
        parts,
      );
      expect(await computer.run(TASK)).toMatchObject({
        status: "stuck",
        reason: "The decision named something it was not offered, so it stopped.",
      });
      expect(parts.actions).toEqual([]);
    });

    it("stops on an answer to a question it did not ask, or of the wrong type", async () => {
      const extra = skool();
      expect(
        await computerWith(
          [{ surface: choice("browser"), tab: choice("t1"), launch: choice("yes") }],
          extra,
        ).computer.run(TASK),
      ).toMatchObject({ status: "stuck" });
      expect(extra.activated).toEqual([]);
      const wrongType = skool();
      expect(
        await computerWith(
          [{ surface: { type: "noul", probability: 0.9 } }],
          wrongType,
        ).computer.run(TASK),
      ).toMatchObject({ status: "stuck" });
      expect(wrongType.activated).toEqual([]);
    });

    it("refuses typing when the screen offered no text box to type into", async () => {
      const parts = skool();
      const { computer } = computerWith(
        [
          { surface: choice("browser"), tab: choice("t1") },
          { next: choice("type_text"), type_into: choice("c1") },
        ],
        parts,
      );
      expect(await computer.run(TASK)).toMatchObject({ status: "stuck" });
      expect(parts.actions).toEqual([]);
    });
  });

  describe("bounds", () => {
    /** A long page: every scroll shows a new part of it, so scrolling never looks like a repeat. */
    function longPage() {
      const actions: ScreenAction[] = [];
      let part = 0;
      const page: ScreenBackend = {
        kind: "desktop",
        observe: async () => ({
          backend: "desktop",
          app: "Safari",
          title: `Part ${part}`,
          controls: [control("0.1", "link", `Link ${part}`)],
        }),
        act: async (action) => {
          actions.push(action);
          part += 1;
        },
      };
      return { page, actions };
    }
    const scrollForever = () => ({
      ask: vi.fn(async (_state: unknown, questions: Record<string, Question>): Promise<Answers> =>
        "surface" in questions ? { surface: choice("current") } : { next: choice("scroll_down") },
      ),
    });

    it("stops after the step limit from use.start, never more than 15", async () => {
      const short = longPage();
      const box = allowAll();
      const computer = new ComputerUse({
        decider: scrollForever(),
        authorize: box.authorize,
        tabs: null,
        desktop: short.page,
        dock: null,
        apps: null,
        log: silentLogger,
        settleMs: 0,
        sleep: async () => undefined,
      });
      expect(
        await computer.run({ goal: "read the page", text: null }, { limits: { maxSteps: 3 } }),
      ).toMatchObject({ status: "stuck", reason: "It did not finish within 3 steps." });
      expect(short.actions).toHaveLength(3);
      expect(box.requests).toHaveLength(3);
      const long = longPage();
      const clamped = new ComputerUse({
        decider: scrollForever(),
        authorize: allowAll().authorize,
        tabs: null,
        desktop: long.page,
        dock: null,
        apps: null,
        log: silentLogger,
        settleMs: 0,
        sleep: async () => undefined,
      });
      expect(
        await clamped.run({ goal: "read the page", text: null }, { limits: { maxSteps: 100 } }),
      ).toMatchObject({ reason: "It did not finish within 15 steps." });
      expect(long.actions).toHaveLength(15);
    });

    it("stops when its working time is up, and time spent deciding or waiting for a tap does not count", async () => {
      /** Each step spends `workMs` acting, and `waitMs` inside the decider and the grant. */
      const runWith = async (workMs: number, waitMs: number, limits: RunOptions["limits"] = {}) => {
        let clock = 0;
        const page = longPage();
        const action = page.page.act.bind(page.page);
        page.page.act = async (given, options) => {
          clock += workMs;
          return action(given, options);
        };
        const decider = {
          ask: vi.fn(
            async (_state: unknown, questions: Record<string, Question>): Promise<Answers> => {
              clock += waitMs;
              return "surface" in questions
                ? { surface: choice("current") }
                : { next: choice("scroll_down") };
            },
          ),
        };
        const authorize = vi.fn(async (): Promise<Grant> => {
          clock += waitMs;
          return ALLOW;
        });
        const computer = new ComputerUse({
          decider,
          authorize,
          tabs: null,
          desktop: page.page,
          dock: null,
          apps: null,
          log: silentLogger,
          settleMs: 0,
          sleep: async () => undefined,
          now: () => clock,
        });
        return {
          outcome: await computer.run({ goal: "read the page", text: null }, { limits }),
          actions: page.actions,
        };
      };
      // Each step's own action takes 40 s: the fourth starts past the 90 s limit.
      const working = await runWith(40_000, 0);
      expect(working.outcome).toMatchObject({ status: "stuck", reason: "It was taking too long." });
      expect(working.actions).toHaveLength(3);
      // Five minutes inside the decider and the grant each step change nothing: that is not working time.
      const waiting = await runWith(1_000, 300_000);
      expect(waiting.outcome).toMatchObject({ reason: "It did not finish within 15 steps." });
      expect(waiting.actions).toHaveLength(15);
      // A longer limit from the server is clamped to 90 s.
      expect((await runWith(40_000, 0, { timeoutMs: 600_000 })).actions).toHaveLength(3);
    });

    it('steers away from an action that did nothing: the next question leaves it out, and only "stuck" then ends it', async () => {
      const actions: ScreenAction[] = [];
      const page: ScreenBackend = {
        kind: "desktop",
        observe: async () => ({
          backend: "desktop",
          app: "Mail",
          title: "Inbox",
          controls: [control("0.1", "button", "Refresh"), control("0.2", "button", "Archive")],
        }),
        act: async (action) => void actions.push(action),
      };
      const { computer, asked } = computerWith(
        [
          { surface: choice("current") },
          { next: choice("c0") },
          { next: choice("c0") },
          { next: choice("stuck") },
        ],
        { page, tabs: null },
      );
      expect(
        await computer.run({ goal: "refresh the inbox until mail arrives", text: null }),
      ).toMatchObject({
        status: "stuck",
        reason:
          "It kept doing the same thing (clicked the button “Refresh”) without the screen changing, and nothing else on screen looked right.",
      });
      // Refresh once; the same choice on the same screen is not done again but steered away from.
      expect(actions).toHaveLength(1);
      const last = asked.at(-1)!;
      expect(
        Object.keys((last.questions.next as { criteria: Record<string, string> }).criteria),
      ).not.toContain("c0");
      expect((last.state as { triedWithoutEffect?: string[] }).triedWithoutEffect).toEqual([
        "clicked the button “Refresh”",
      ]);
    });

    it("a step the backend cannot do in the background asks the person for their mouse, then does it with the pointer", async () => {
      const calls: Array<{ kind: string; allow: boolean }> = [];
      const page: ScreenBackend = {
        kind: "desktop",
        observe: async () => ({
          backend: "desktop",
          app: "Figma",
          title: "Canvas",
          controls: [
            control("0.1", "other", "drawing canvas", { bounds: { x: 10, y: 20, w: 100, h: 100 } }),
          ],
        }),
        act: async (action, options) => {
          calls.push({ kind: action.kind, allow: options?.allowPointer === true });
          if (!options?.allowPointer)
            throw new NeedsPointer("that control draws itself and has no accessible action");
          return { mode: "pointer", pointer: { x: 60, y: 70 }, at: { x: 60, y: 70 } };
        },
      };
      const requests: AuthorizeRequest[] = [];
      const authorize = vi.fn(async (r: AuthorizeRequest): Promise<Grant> => {
        requests.push(r);
        return { ok: true, grant: "allow" };
      });
      const { computer } = computerWith(
        [{ surface: choice("current") }, { next: choice("c0") }, { next: choice("done") }],
        { page, tabs: null },
        authorize,
      );
      const outcome = await computer.run({ goal: "click the canvas", text: null });
      expect(outcome.status).toBe("done");
      // First attempted in the background, then the real pointer after the person allowed it.
      expect(calls).toEqual([
        { kind: "click", allow: false },
        { kind: "click", allow: true },
      ]);
      // The person was asked for the pointer, with the reason.
      const pointerReq = requests.find((r) => r.action.kind === "pointer");
      expect(pointerReq?.action).toMatchObject({
        kind: "pointer",
        why: expect.stringMatching(/accessible action/),
      });
      expect(outcome.steps.at(-1)).toContain("(with your mouse, as you allowed)");
    });

    it("a background action that changes nothing is steered away, never retried with the pointer behind the person’s back", async () => {
      const calls: Array<{ allow: boolean }> = [];
      const page: ScreenBackend = {
        kind: "desktop",
        observe: async () => ({
          backend: "desktop",
          app: "Mail",
          title: "Inbox",
          controls: [control("0.1", "button", "Refresh"), control("0.2", "button", "Archive")],
        }),
        act: async (_action, options) => {
          calls.push({ allow: options?.allowPointer === true });
          return { mode: "background" };
        },
      };
      const { computer, asked } = computerWith(
        [
          { surface: choice("current") },
          { next: choice("c0") },
          { next: choice("c0") },
          { next: choice("stuck") },
        ],
        { page, tabs: null },
      );
      expect(await computer.run({ goal: "refresh the inbox", text: null })).toMatchObject({
        status: "stuck",
      });
      // Refresh was tried once in the background; the same choice on the unchanged screen was steered away, never a pointer click.
      expect(calls).toEqual([{ allow: false }]);
      expect(
        Object.keys(
          (asked.at(-1)!.questions.next as { criteria: Record<string, string> }).criteria,
        ),
      ).not.toContain("c0");
    });

    it("keeps scrolling a list whose rows change even when as many are visible each time", async () => {
      const actions: ScreenAction[] = [];
      let first = 0;
      const rows = () =>
        Array.from({ length: 20 }, (_, i) => control(`0.${i}`, "row", `Message ${first + i}`));
      const page: ScreenBackend = {
        kind: "desktop",
        observe: async () => ({
          backend: "desktop",
          app: "Mail",
          title: "Inbox",
          controls: rows(),
        }),
        act: async (action) => {
          actions.push(action);
          first += 20;
        },
      };
      const replies: Answers[] = [
        { surface: choice("current") },
        { next: choice("scroll_down") },
        { next: choice("scroll_down") },
        { next: choice("scroll_down") },
        { next: choice("scroll_down") },
        { next: choice("done") },
      ];
      const { computer } = computerWith(replies, { page, tabs: null });
      expect(
        await computer.run({ goal: "scroll down to the oldest mail", text: null }),
      ).toMatchObject({ status: "done" });
      expect(actions).toHaveLength(4);
    });

    it("after steering, does what the decider picks instead", async () => {
      const actions: ScreenAction[] = [];
      let archived = false;
      const page: ScreenBackend = {
        kind: "desktop",
        observe: async () => ({
          backend: "desktop",
          app: "Mail",
          title: archived ? "Archived" : "Inbox",
          controls: [control("0.1", "button", "Refresh"), control("0.2", "button", "Archive")],
        }),
        act: async (action) => {
          actions.push(action);
          if (action.kind === "click" && action.ref === "0.2") archived = true;
        },
      };
      const { computer } = computerWith(
        [
          { surface: choice("current") },
          { next: choice("c0") },
          { next: choice("c0") },
          { next: choice("c1") },
          { next: choice("done") },
        ],
        { page, tabs: null },
      );
      expect(await computer.run({ goal: "archive the message", text: null })).toMatchObject({
        status: "done",
      });
      expect(actions).toEqual([
        { kind: "click", ref: "0.1" },
        { kind: "click", ref: "0.2" },
      ]);
    });

    it("opens the address a goal names itself, instead of leaving the address bar to the decider (TestFlight run, 2026-11-18)", async () => {
      let url = "https://dev-box.example.ts.net/storage";
      const page: ScreenBackend = {
        kind: "desktop",
        observe: async () => ({
          backend: "desktop",
          app: "Google Chrome",
          title: url.includes("appstoreconnect") ? "Apps - App Store Connect" : "Agent Storage",
          url,
          controls: [control("0.7", "textbox", "Address and search bar")],
        }),
        act: async () => undefined,
      };
      const server = allowAll();
      const { computer, asked } = computerWith(
        [{ surface: choice("current") }, { next: choice("done") }],
        { page, tabs: null },
        server.authorize,
        {
          urls: {
            open: async (address) => {
              url = address;
              return "Google Chrome";
            },
          },
        },
      );
      const outcome = await computer.run({
        goal: "Open https://appstoreconnect.apple.com/apps in the user's default browser. Go to the TestFlight section and report the latest build.",
        text: null,
      });
      expect(outcome).toMatchObject({ status: "done" });
      expect(url).toBe("https://appstoreconnect.apple.com/apps");
      expect(server.requests.map((request) => request.action)).toContainEqual({
        kind: "open_url",
        url: "https://appstoreconnect.apple.com/apps",
      });
      // The decider's first look at the page is after it opened.
      expect(asked).toHaveLength(2);
      expect(asked[1]?.state).toMatchObject({ screen: { url } });
    });

    it("a navigation goal is not done when a tab is clicked, nor until the page on screen is the one asked for (Windows run, 2026-10-25)", async () => {
      const blank: BrowserTab = {
        window: 0,
        index: 1,
        title: "New Tab",
        url: "chrome://newtab/",
        active: false,
      };
      let url = "chrome://newtab/";
      const page: ScreenBackend = {
        kind: "desktop",
        observe: async () => ({
          backend: "desktop",
          app: "Google Chrome",
          title: url === "chrome://newtab/" ? "New Tab" : "Example Domain",
          url,
          controls: [control("0.7", "textbox", "Address and search bar", { focused: true })],
        }),
        act: async (action) => {
          if (action.kind === "press") url = "example.com";
        },
      };
      const tabs: BrowserTabs = {
        browser: "Google Chrome",
        list: async () => [blank],
        activate: async () => undefined,
      };
      const { computer, asked } = computerWith(
        [
          { surface: choice("browser"), tab: choice("t0") },
          { next: choice("type_text"), type_into: choice("c0") },
          { next: choice("press_enter") },
          { next: choice("done") },
        ],
        { page, tabs },
      );
      expect(
        await computer.run({ goal: "open Chrome and go to example.com", text: null }),
      ).toMatchObject({ status: "done" });
      const offered = asked
        .slice(1)
        .map((a) =>
          Object.keys((a.questions.next as { criteria: Record<string, string> }).criteria).includes(
            "done",
          ),
        );
      // On the blank tab "done" is not an option; once example.com is on screen the task ends by itself (only going there).
      expect(offered).toEqual([false, false]);
      expect(
        navigationUnmet("go to example.com", {
          backend: "desktop",
          app: "Edge",
          title: "x",
          url: "https://www.example.com/path",
          controls: [],
        }),
      ).toBe(false);
      expect(
        navigationUnmet("go to example.com", {
          backend: "desktop",
          app: "Edge",
          title: "x",
          url: "docs.example.com",
          controls: [],
        }),
      ).toBe(false);
      expect(
        navigationUnmet("go to example.com", {
          backend: "desktop",
          app: "Edge",
          title: "x",
          url: "https://notexample.com/",
          controls: [],
        }),
      ).toBe(true);
      expect(
        navigationUnmet("go to example.com", {
          backend: "desktop",
          app: "Edge",
          title: "x",
          controls: [],
        }),
      ).toBe(false);
    });

    it("types the address again when an Enter went elsewhere and the bar put the old page back (Windows run, 2026-10-25: stuck after 15 steps)", async () => {
      const old = "github.com/jayleaton/localrouter";
      let bar = old;
      let focused = false;
      let loaded = false;
      let typedOnce = false;
      const page: ScreenBackend = {
        kind: "desktop",
        observe: async () => ({
          backend: "desktop",
          app: "Google Chrome",
          title: loaded ? "Example Domain" : "Ada",
          url: loaded ? "example.com" : old,
          controls: [control("0.7", "textbox", "Address and search bar", { value: bar, focused })],
        }),
        act: async (action) => {
          if (action.kind === "type") {
            // The first time the value is set without the focus (as ValuePattern did); the second time with it.
            bar = action.text;
            if (!focused) focused = typedOnce;
            typedOnce = true;
          }
          if (action.kind === "press" && action.key === "enter") {
            if (focused) loaded = true;
            else bar = old; // Enter went to the page; the bar reverts to the page's address
          }
          return { mode: "background" };
        },
      };
      const { authorize, requests } = allowAll();
      const replies: Answers[] = [
        { surface: choice("current") },
        { next: choice("type_text"), type_into: choice("c0") },
        { next: choice("press_enter") },
        { next: choice("type_text"), type_into: choice("c0") },
        { next: choice("press_enter") },
        { next: choice("done") },
      ];
      const { computer, asked } = computerWith(replies, { page, tabs: null }, authorize);
      expect(await computer.run({ goal: "go to example.com", text: null })).toMatchObject({
        status: "done",
      });
      expect(requests.map((r) => r.action.kind)).toEqual(["type", "press", "type", "press"]);
      // After the bar reverted, typing was offered again.
      expect(
        Object.keys((asked[3]!.questions.next as { criteria: Record<string, string> }).criteria),
      ).toContain("type_text");
    });

    it('"go to example.com" in Chrome with the address bar focused: types the address and presses Enter, never clicks the bar again (JJ’s MacBook, 2026-10-25)', async () => {
      let typed = "";
      let loaded = false;
      const bar = () =>
        control("0.7", "textbox", "Address and search bar", {
          value: typed || "https://github.com/jayleaton/t3code/pull/138",
          focused: true,
        });
      const page: ScreenBackend = {
        kind: "desktop",
        observe: async () => ({
          backend: "desktop",
          app: "Google Chrome",
          title: loaded ? "Example Domain" : "Pull request #138",
          url: loaded ? "https://example.com/" : "https://github.com/jayleaton/t3code/pull/138",
          controls: [control("0.2", "button", "Reload"), bar()],
        }),
        act: async (action) => {
          if (action.kind === "type") typed = action.text;
          if (action.kind === "press" && action.key === "enter" && typed) loaded = true;
        },
      };
      const { authorize, requests } = allowAll();
      // What the decider did on the Mac: it chose the focused address bar ("click"), twice and more.
      const { computer, asked } = computerWith(
        [
          { surface: choice("current") },
          { next: choice("c1") },
          { next: choice("press_enter") },
          { next: choice("done") },
        ],
        { page, tabs: null },
        authorize,
      );
      expect(
        await computer.run({ goal: "open Chrome and go to example.com", text: null }),
      ).toMatchObject({ status: "done" });
      expect(requests.map((r) => r.action)).toEqual([
        {
          kind: "type",
          ref: "0.7",
          role: "textbox",
          label: "Address and search bar",
          text: "example.com",
        },
        {
          kind: "press",
          key: "enter",
          field: { role: "textbox", label: "Address and search bar" },
        },
      ]);
      // Typing was offered from the first step: the address is the goal's own text.
      expect(
        Object.keys((asked[1]!.questions.next as { criteria: Record<string, string> }).criteria),
      ).toContain("type_text");
    });

    it("stops before its next action when aborted, with the reason given", async () => {
      const parts = skool();
      const controller = new AbortController();
      const authorize = vi.fn(async (request: AuthorizeRequest): Promise<Grant> => {
        if (request.action.kind === "click") controller.abort("You stopped it on the Mac.");
        return ALLOW;
      });
      const { computer } = computerWith(SKOOL_REPLIES(), parts, authorize);
      expect(await computer.run(TASK, { signal: controller.signal })).toMatchObject({
        status: "stopped",
        reason: "You stopped it on the Mac.",
      });
      expect(parts.actions).toEqual([]);
    });
  });

  describe('clicking named things (2026-09-26: "click the tab ‘Widget library review — Sidebud’" was refused three times)', () => {
    /** Chrome with two Sidebud tabs, so a model choice between them is split, as it was live. */
    const tabs: BrowserTab[] = [
      {
        window: 0,
        index: 0,
        title: "Sidebud · Computer",
        url: "http://127.0.0.1:8421/",
        active: true,
      },
      {
        window: 0,
        index: 1,
        title: "Widget library review — Sidebud",
        url: "https://sidebud.app/admin/widgets",
        active: false,
      },
    ];
    /** The front Chrome window: its tab strip is on screen as tab controls. */
    const tabStrip: Observation = {
      backend: "desktop",
      app: "Google Chrome",
      title: "Sidebud · Computer",
      controls: [
        control("0.1.0", "tab", "Sidebud · Computer"),
        control("0.1.1", "tab", "Widget library review — Sidebud - Memory usage - 88 MB"),
        control("0.2", "button", "New Tab"),
      ],
    };

    function chrome() {
      const actions: ScreenAction[] = [];
      const activated: BrowserTab[] = [];
      const broughtForward: string[] = [];
      const desktop: ScreenBackend = {
        kind: "desktop",
        observe: async () => tabStrip,
        act: async (action) => void actions.push(action),
      };
      const parts = {
        tabs: {
          browser: "Google Chrome",
          list: async () => tabs,
          activate: async (tab: BrowserTab) => void activated.push(tab),
        },
        desktop,
      };
      const dock = {
        list: async () => ["Finder", "Google Chrome", "T3 Agents"],
        activate: async (name: string) => void broughtForward.push(name),
      };
      return { parts, dock, actions, activated, broughtForward };
    }
    const run = (replies: Answers[], setup: ReturnType<typeof chrome>, goal: string) => {
      const { decider, asked } = scripted(replies);
      const box = allowAll();
      const computer = new ComputerUse({
        decider,
        authorize: box.authorize,
        tabs: setup.parts.tabs,
        desktop: setup.parts.desktop,
        dock: setup.dock,
        apps: {
          running: async () => ["Google Chrome", "stable", "parsecd"],
          activate: async () => undefined,
        },
        log: silentLogger,
        settleMs: 0,
        sleep: async () => undefined,
      });
      return { outcome: computer.run({ goal, text: null }), asked, requests: box.requests };
    };

    it("clicks a tab the goal names exactly, without guessing among similar tabs, and is done", async () => {
      const setup = chrome();
      const { outcome, asked, requests } = run(
        [{ surface: choice("browser"), app: choice("a1") }],
        setup,
        'Open the Google Chrome app window and click its tab labelled "Widget library review — Sidebud" in the tab strip.',
      );
      expect(await outcome).toMatchObject({ status: "done" });
      expect(setup.activated).toEqual([tabs[1]]);
      // The name matched a tab, so the server was not asked to choose one.
      expect(asked[0]!.questions).not.toHaveProperty("tab");
      expect(requests.map((request) => request.action)).toEqual([
        { kind: "surface", what: "tab", name: "Widget library review — Sidebud" },
      ]);
      expect(requests[0]!.observation).toEqual({
        app: "Google Chrome",
        title: "Sidebud · Computer",
      });
    });

    it("does not give up when no tab is clearly meant: brings Chrome forward from the Dock and clicks the tab on screen", async () => {
      const setup = chrome();
      const split: Answer = { type: "choice", choice: "t1", probability: 0.34 };
      const { outcome, asked, requests } = run(
        [
          { surface: choice("browser"), tab: split, app: choice("a1") },
          { next: choice("c1") },
          { next: choice("done") },
        ],
        setup,
        "Switch to the Google Chrome window and select the tab where the widget library review is open.",
      );
      expect(await outcome).toMatchObject({ status: "done" });
      expect(setup.broughtForward).toEqual(["Google Chrome"]);
      expect(setup.actions).toEqual([{ kind: "click", ref: "0.1.1" }]);
      expect(requests.map((request) => request.action.kind)).toEqual(["surface", "click"]);
      expect(requests[0]!.action).toEqual({ kind: "surface", what: "app", name: "Google Chrome" });
      // Apps come from the Dock (then running apps), not background processes first.
      const app = asked[0]!.questions.app;
      expect(app?.type === "choice" ? Object.values(app.criteria).slice(0, 3) : []).toEqual([
        "Finder",
        "Google Chrome",
        "T3 Agents",
      ]);
    });

    it("says plainly when a named tab is not there, after looking at the tab strip", async () => {
      const setup = chrome();
      const { outcome } = run(
        [{ surface: choice("browser"), app: choice("a1") }, { next: choice("stuck") }],
        setup,
        'Click the tab "Billing settings" in Google Chrome.',
      );
      expect(await outcome).toMatchObject({
        status: "stuck",
        reason: "It could not find “Billing settings” in Google Chrome.",
      });
      expect(setup.broughtForward).toEqual(["Google Chrome"]);
    });

    it("clicks a named button in a named app on screen by matching its label, granted like any click", async () => {
      const setup = chrome();
      const { outcome, requests } = run(
        [{ surface: choice("app"), app: choice("a1") }],
        setup,
        'In Google Chrome, click the button "New Tab".',
      );
      expect(await outcome).toMatchObject({ status: "done" });
      expect(setup.broughtForward).toEqual(["Google Chrome"]);
      expect(setup.actions).toEqual([{ kind: "click", ref: "0.2" }]);
      expect(requests.at(-1)?.action).toEqual({
        kind: "click",
        ref: "0.2",
        role: "button",
        label: "New Tab",
      });
    });
  });
});

describe("an act the agent chose", () => {
  const actWith = (extra: Partial<Deps> = {}) => {
    const page = new FakeNotes();
    const server = allowAll();
    const acted: Array<{ kind: string; mode: string }> = [];
    const { computer } = computerWith([], { page, tabs: null }, server.authorize, {
      onAct: (action, result) => acted.push({ kind: action.kind, mode: result.mode }),
      ...extra,
    });
    return { page, server, acted, computer };
  };

  it("clicks by label in the background, through the server's grant, with no decider", async () => {
    const { page, server, acted, computer } = actWith();
    const outcome = await computer.run({
      goal: "",
      text: null,
      act: { action: "click", label: "New Note" },
    });
    expect(outcome).toMatchObject({ status: "done", steps: ["clicked the button “New Note”"] });
    expect(server.requests[0]?.action).toEqual({
      kind: "click",
      ref: "new",
      role: "button",
      label: "New Note",
    });
    expect(page.notes.at(-1)).toBe("New Note");
    expect(acted).toEqual([{ kind: "click", mode: "background" }]);
  });

  it("asks once for the mouse when the background cannot take the step", async () => {
    const { page, server, acted, computer } = actWith();
    page.pointerOnly.add("new");
    await computer.run({ goal: "", text: null, act: { action: "click", ref: "new" } });
    expect(server.requests.map((request) => request.action.kind)).toEqual(["click", "pointer"]);
    expect(acted).toEqual([{ kind: "click", mode: "pointer" }]);
  });

  it("types into the focused box, or stops when none has the focus", async () => {
    const { page, server, computer } = actWith();
    expect(await computer.run({ goal: "", text: "milk", act: { action: "type" } })).toMatchObject({
      status: "stuck",
      reason: expect.stringMatching(/No text box has the focus/),
    });
    await computer.run({ goal: "", text: null, act: { action: "click", ref: "search" } });
    await computer.run({ goal: "", text: "milk", act: { action: "type" } });
    expect(server.requests.at(-1)?.action).toMatchObject({
      kind: "type",
      ref: "search",
      text: "milk",
    });
    expect(page.query).toBe("milk");
    await computer.run({ goal: "", text: null, act: { action: "key", key: "return" } });
    expect(server.requests.at(-1)?.action).toMatchObject({ kind: "press", key: "enter" });
    expect(page.searched).toBe(true);
  });

  it("opens a web address in the default browser once it is granted, and names the browser", async () => {
    const opened: string[] = [];
    const { server, computer } = actWith({
      urls: {
        open: async (url) => {
          opened.push(url);
          return "Safari";
        },
      },
    });
    const outcome = await computer.run({
      goal: "",
      text: null,
      act: { action: "open_url", url: "https://example.com" },
    });
    expect(server.requests[0]?.action).toEqual({ kind: "open_url", url: "https://example.com" });
    expect(opened).toEqual(["https://example.com"]);
    expect(outcome).toMatchObject({
      status: "done",
      surface: "Safari",
      steps: ["opened new tab: https://example.com in Safari"],
    });
  });

  it("takes the short ref a look gave, and finds that control again even when its path moved", async () => {
    const refs = new Map([["e1", control("0.9.search", "textbox", "Search")]]);
    const { server, computer } = actWith({ refs });
    await computer.run({ goal: "", text: null, act: { action: "click", ref: "e1" } });
    expect(server.requests[0]?.action).toMatchObject({
      kind: "click",
      ref: "search",
      label: "Search",
    });
    expect(
      await computer.run({ goal: "", text: null, act: { action: "click", ref: "e9" } }),
    ).toMatchObject({ status: "stuck", reason: "That control is gone; look again." });
  });

  it("opens a control's context menu and picks an item from it by label, in the background", async () => {
    const { page, server, computer } = actWith();
    expect(
      await computer.run({ goal: "", text: null, act: { action: "menu", ref: "search" } }),
    ).toMatchObject({
      status: "done",
      steps: ["opened the menu of the textbox “Search”", "popup open now: Paste | Select password"],
    });
    expect(
      await computer.run({
        goal: "",
        text: null,
        act: { action: "click", label: "Select password" },
      }),
    ).toMatchObject({
      status: "done",
      steps: [
        "picked “Select password” from the menu",
        "popup open now: Password for dana@acme.test",
      ],
    });
    expect(
      await computer.run({
        goal: "",
        text: null,
        act: { action: "click", label: "Password for dana@acme.test" },
      }),
    ).toMatchObject({
      status: "done",
      steps: ["picked “Password for dana@acme.test” from the menu"],
    });
    expect(server.requests.map((request) => request.action)).toEqual([
      { kind: "click", ref: "search", role: "textbox", label: "Search" },
      { kind: "click", ref: "menu", role: "menuitem", label: "Select password" },
      { kind: "click", ref: "menu", role: "menuitem", label: "Password for dana@acme.test" },
    ]);
    expect(page.picked).toEqual(["Select password", "Password for dana@acme.test"]);
  });

  it("switches to a tab already on the site, or the sign-in page it led to, instead of opening another", async () => {
    const opened: string[] = [];
    const pressed: string[] = [];
    const tabs: BrowserTab[] = [
      {
        window: 0,
        index: 0,
        title: "Agent Storage",
        url: "https://dev.example.net/",
        active: true,
      },
    ];
    let landedOn = "https://idmsa.apple.com/signin";
    const { computer } = actWith({
      tabs: {
        browser: "Google Chrome",
        list: async () => tabs,
        activate: async () => {
          throw new Error("the real pointer is never used to switch tabs");
        },
        press: async (tab) => {
          pressed.push(tab.title);
        },
      },
      urls: {
        browser: async () => "Google Chrome",
        open: async (url) => {
          opened.push(url);
          for (const tab of tabs) tab.active = false;
          tabs.push({ window: 0, index: 1, title: "Sign In", url: landedOn, active: true });
          return "Google Chrome";
        },
      },
      landed: new Map(),
    });
    const open = () =>
      computer.run({
        goal: "",
        text: null,
        act: { action: "open_url", url: "https://appstoreconnect.apple.com/apps" },
      });
    expect((await open()).steps).toEqual([
      "opened new tab: https://appstoreconnect.apple.com/apps in Google Chrome",
    ]);
    landedOn = "unused";
    // The first open led to Apple's sign-in host: opening the same site again goes back to that tab.
    expect((await open()).steps).toEqual(["reused existing tab: “Sign In” in Google Chrome"]);
    expect(opened).toHaveLength(1);
    expect(pressed).toEqual(["Sign In"]);
  });
});

describe("ComputerUseRuns", () => {
  const session: Session = { decider: { ask: async () => ({}) }, authorize: async () => ALLOW };

  it("runs one task at a time: a second start is refused busy, and stop ends the first before its next step", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const computer = {
      available: true,
      run: async (_task: ComputerTask, options: RunOptions) => {
        await gate;
        return {
          status: options.signal?.aborted ? "stopped" : "done",
          reason: "",
          steps: [],
          surface: null,
        };
      },
    } as unknown as ComputerUse;
    const started: ComputerTask[] = [];
    const runs = new ComputerUseRuns({
      create: () => computer,
      onStart: (task) => void started.push(task),
      log: silentLogger,
    });
    const first = runs.start("task_1", TASK, session);
    expect(runs.start("task_2", { goal: "something else", text: null }, session)).toEqual({
      ok: false,
      error: "busy",
    });
    expect(runs.current).toEqual({ id: "task_1", goal: TASK.goal });
    expect(started).toEqual([TASK]);
    expect(runs.stop("task_2")).toBe(false);
    expect(runs.stop("task_1")).toBe(true);
    release();
    if (!first.ok) throw new Error("the first start was refused");
    expect(await first.finished).toMatchObject({ status: "stopped" });
    expect(runs.current).toBeNull();
    expect(runs.start("task_3", TASK, session).ok).toBe(true);
  });

  it("gives each task its own local stop and ends it with the task", async () => {
    const ended: string[] = [];
    let abort: (reason: string) => void = () => undefined;
    const computer = {
      available: true,
      run: async (_task: ComputerTask, options: RunOptions) => {
        abort("You stopped it on the Mac.");
        return {
          status: options.signal?.aborted ? "stopped" : "done",
          reason: "",
          steps: [],
          surface: null,
        };
      },
    } as unknown as ComputerUse;
    const runs = new ComputerUseRuns({
      create: () => computer,
      watch: (stop) => {
        abort = stop;
        return {
          check: async () => undefined,
          moving: () => undefined,
          left: () => undefined,
          end: () => void ended.push("end"),
        };
      },
      log: silentLogger,
    });
    const started = runs.start("task_1", TASK, session);
    if (!started.ok) throw new Error("refused");
    expect(await started.finished).toMatchObject({ status: "stopped" });
    expect(ended).toEqual(["end"]);
  });
});

describe("quotedTargets", () => {
  it("reads the names a goal quotes, in any quote style", () => {
    expect(
      quotedTargets(
        "click its tab labelled 'Widget library review — Sidebud' in Chrome's tab strip",
      ),
    ).toEqual(["Widget library review — Sidebud"]);
    expect(quotedTargets('In T3, click “New agent”, then the "Settings" button')).toEqual([
      "New agent",
      "Settings",
    ]);
  });
});

describe('going to a tab by what the user called it (2026-09-26 07:36: "the school tab" worked but was reported as a failure)', () => {
  /** The owner's Chrome: the Skool community's tab is titled "Early AI-dopters" and lives on skool.com. */
  const tabs: BrowserTab[] = [
    {
      window: 0,
      index: 0,
      title: "Search results - Gmail",
      url: "https://mail.google.com/mail/u/3/",
      active: true,
    },
    {
      window: 0,
      index: 4,
      title: "Early AI-dopters",
      url: "https://www.skool.com/earlyaidopters",
      active: false,
    },
    {
      window: 0,
      index: 10,
      title: "Sidebud · Computer",
      url: "http://127.0.0.1:8421/",
      active: false,
    },
    {
      window: 0,
      index: 11,
      title: "Internal testing | Sidebud",
      url: "https://play.google.com/console/u/3/developers/1",
      active: false,
    },
  ];

  it("finds a tab by its site or by how the name sounds, not only by its title", () => {
    expect(soundKey("school")).toBe(soundKey("Skool"));
    expect(resolveTab(["school"], tabs)).toMatchObject({ tab: tabs[1], via: "sound" });
    expect(resolveTab(["skool"], tabs)).toMatchObject({ tab: tabs[1], via: "site" });
    expect(resolveTab(["early ai-dopters"], tabs)).toMatchObject({ tab: tabs[1], via: "title" });
    // Two tabs mention Sidebud: not clear, so the server chooses instead.
    expect(resolveTab(["sidebud"], tabs)).toBeNull();
    // A tab group's name picks its active tab, else its first.
    expect(
      resolveTab(["work"], tabs, [
        {
          name: "Work",
          tabs: ["Sidebud · Computer - Memory usage - 88 MB", "Internal testing | Sidebud"],
        },
      ]),
    ).toMatchObject({ tab: tabs[2], via: "group" });
  });

  it("reports a successful switch as done and does not read the page for the spoken name afterwards", async () => {
    const actions: ScreenAction[] = [];
    const activated: BrowserTab[] = [];
    const observe = vi.fn(async (): Promise<Observation> => ({
      backend: "desktop",
      app: "Google Chrome",
      title: "Gmail",
      controls: [],
    }));
    const box = allowAll();
    const computer = new ComputerUse({
      decider: { ask: vi.fn(async (): Promise<Answers> => ({ surface: choice("browser") })) },
      authorize: box.authorize,
      log: silentLogger,
      settleMs: 0,
      apps: null,
      dock: null,
      tabs: {
        browser: "Google Chrome",
        list: async () => tabs,
        activate: async (tab) => void activated.push(tab),
      },
      desktop: { kind: "desktop", observe, act: async (action) => void actions.push(action) },
    });
    const outcome = await computer.run({
      goal: 'Navigate to the tab labeled "school" in the Chrome browser.',
      text: null,
    });
    expect(outcome).toMatchObject({ status: "done", surface: "Google Chrome: Early AI-dopters" });
    expect(activated).toEqual([tabs[1]]);
    expect(outcome.steps[0]).toContain("(www.skool.com)");
    // The screen is read once, before the switch, for the server's grant; "school" is not looked for afterwards.
    expect(observe).toHaveBeenCalledTimes(1);
    expect(box.requests).toEqual([
      {
        step: 1,
        observation: { app: "Google Chrome", title: "Gmail" },
        action: { kind: "surface", what: "tab", name: "Early AI-dopters" },
      },
    ]);
    expect(actions).toEqual([]);
  });

  it("counts a tab the server chose by meaning as the switch the user asked for, even when the screen cannot be read", async () => {
    const activated: BrowserTab[] = [];
    const box = allowAll();
    const computer = new ComputerUse({
      decider: {
        ask: vi.fn(async (): Promise<Answers> => ({
          surface: choice("browser"),
          tab: choice("t1"),
        })),
      },
      authorize: box.authorize,
      log: silentLogger,
      settleMs: 0,
      apps: null,
      dock: null,
      tabs: {
        browser: "Google Chrome",
        list: async () => tabs,
        activate: async (tab) => void activated.push(tab),
      },
      desktop: {
        kind: "desktop",
        observe: async () => {
          throw new Error("should not read the screen");
        },
        act: async () => undefined,
      },
    });
    expect(
      await computer.run({ goal: "Switch to my AI community tab in Chrome.", text: null }),
    ).toMatchObject({ status: "done" });
    expect(activated).toEqual([tabs[1]]);
    expect(box.requests[0]!.observation).toEqual({ app: "", title: "" });
  });
});

describe('a Chrome that refuses other apps (2026-09-26 10:17: "could not find ‘YouTube’ in Google Chrome" on every try)', () => {
  const REFUSED =
    "Google Chrome is refusing to show its window to other apps: macOS can no longer verify the running Google Chrome (a file it runs from was changed or removed while it was open). Quitting and reopening Google Chrome fixes this.";
  /** Chrome's front window read from a screenshot after the switch: text only, no play button. */
  const youtube: Observation = {
    backend: "desktop",
    app: "Google Chrome",
    title: "blink-182 - ONE MORE TIME (Official Video) - YouTube",
    visual: true,
    text: "YouTube Search blink-182 ONE MORE TIME",
    controls: [control("v:120,150", "text", "YouTube"), control("v:500,150", "text", "Search")],
  };

  function unreadableChrome(found: string | null, replies: Answers[], search = true) {
    const searched: string[] = [];
    const broughtForward: string[] = [];
    const actions: ScreenAction[] = [];
    const { decider, asked } = scripted(replies);
    const box = allowAll();
    const tabs: BrowserTabs = {
      browser: "Google Chrome",
      list: async () => {
        throw new Error(REFUSED);
      },
      activate: async () => {
        throw new Error("nothing to click");
      },
      ...(search
        ? {
            search: async (name: string) => {
              searched.push(name);
              return found;
            },
          }
        : {}),
    };
    const computer = new ComputerUse({
      decider,
      authorize: box.authorize,
      log: silentLogger,
      settleMs: 0,
      apps: null,
      dock: {
        list: async () => ["Google Chrome"],
        activate: async (name: string) => void broughtForward.push(name),
      },
      tabs,
      desktop: {
        kind: "desktop",
        observe: async () => youtube,
        act: async (action) => void actions.push(action),
      },
    });
    return { computer, searched, broughtForward, actions, asked, requests: box.requests };
  }

  it("switches to the named tab with the browser’s tab search, granted as a tab switch", async () => {
    const chrome = unreadableChrome("blink-182 - YouTube", [{ surface: choice("browser") }]);
    const outcome = await chrome.computer.run({
      goal: "Switch to the 'YouTube' tab in Google Chrome.",
      text: null,
    });
    expect(outcome).toMatchObject({
      status: "done",
      surface: "Google Chrome: blink-182 - YouTube",
    });
    expect(chrome.searched).toEqual(["YouTube"]);
    expect(chrome.broughtForward).toEqual([]);
    expect(chrome.requests.map((request) => request.action)).toEqual([
      { kind: "surface", what: "tab", name: "YouTube" },
    ]);
  });

  it("then presses play on the page it can only see in a screenshot", async () => {
    const chrome = unreadableChrome("blink-182 - YouTube", [
      { surface: choice("browser") },
      { next: choice("press_space") },
      { next: choice("done") },
    ]);
    const outcome = await chrome.computer.run({
      goal: "Switch to the 'YouTube' tab in Google Chrome and press play.",
      text: null,
    });
    expect(outcome).toMatchObject({ status: "done" });
    expect(outcome.steps).toEqual([
      "switched to the “blink-182 - YouTube” tab with Google Chrome’s tab search",
      "pressed Space",
    ]);
    expect(chrome.actions).toEqual([{ kind: "press", key: "space" }]);
    expect(chrome.requests.at(-1)?.action).toEqual({ kind: "press", key: "space" });
    // The server is told the screen came from a screenshot, so a missing play button is expected.
    const state = chrome.asked[1]!.state as { screen: { readFrom: string } };
    expect(state.screen.readFrom).toContain("screenshot");
  });

  it('finds a site the request goes to among the tabs, then presses play (2026-09-26 14:15: "navigate to youtube.com, and press play")', async () => {
    const chrome = unreadableChrome("blink-182 - ONE MORE TIME (Official Video) - YouTube", [
      { surface: choice("browser") },
      { next: choice("press_space") },
      { next: choice("done") },
    ]);
    const goal =
      "On the screen: bring Google Chrome to the front, navigate to youtube.com, and press play on the video currently displayed on the page.";
    const outcome = await chrome.computer.run({ goal, text: null });
    expect(outcome).toMatchObject({ status: "done" });
    expect(chrome.searched).toEqual(["youtube"]);
    expect(chrome.actions).toEqual([{ kind: "press", key: "space" }]);
  });

  it("works the page from the screen when no tab has the site, instead of giving up", async () => {
    const chrome = unreadableChrome(null, [
      { surface: choice("browser") },
      { next: choice("c0") },
      { next: choice("done") },
    ]);
    expect(
      await chrome.computer.run({
        goal: "Bring Google Chrome to the front and open youtube.com.",
        text: null,
      }),
    ).toMatchObject({ status: "done" });
    expect(chrome.searched).toEqual(["youtube"]);
    expect(chrome.broughtForward).toEqual(["Google Chrome"]);
  });

  it("reads a tab or site the goal names without quotes", () => {
    expect(
      unquotedTabName(
        "On the screen: bring Google Chrome to the front, switch to the YouTube tab, and press play.",
      ),
    ).toBe("YouTube");
    expect(siteNamed("navigate to youtube.com, and press play")).toBe("youtube");
    expect(siteNamed("open https://www.skool.com/earlyaidopters")).toBe("skool");
    expect(unquotedTabName("Scroll down the page")).toBeUndefined();
  });

  it("works from the screen when no tab is named, and says plainly when a named tab is not there", async () => {
    const onScreen = unreadableChrome(
      null,
      [{ surface: choice("browser") }, { next: choice("c0") }, { next: choice("done") }],
      false,
    );
    expect(
      await onScreen.computer.run({ goal: "Click YouTube in Google Chrome.", text: null }),
    ).toMatchObject({ status: "done" });
    expect(onScreen.broughtForward).toEqual(["Google Chrome"]);
    expect(onScreen.actions).toEqual([{ kind: "click", ref: "v:120,150" }]);
    const missing = await unreadableChrome(null, [{ surface: choice("browser") }]).computer.run({
      goal: "Switch to the 'Billing' tab in Google Chrome.",
      text: null,
    });
    expect(missing).toMatchObject({
      status: "unavailable",
      reason: "It could not find a “Billing” tab with Google Chrome’s tab search.",
    });
  });
});

describe("settled", () => {
  // Apple's sign-in page: a spinner, then the frame with the form arrives a few walks later.
  const signIn = (spinnerWalks: number) => {
    let walks = 0;
    const page: ScreenBackend = {
      kind: "desktop",
      observe: async () => {
        walks += 1;
        const loading = walks <= spinnerWalks;
        return {
          backend: "desktop",
          app: "Google Chrome",
          title: "App Store Connect",
          controls: loading
            ? []
            : [
                control("0.4.2", "textbox", "Email or Phone Number"),
                control("0.4.3", "button", "Continue"),
              ],
          ...(loading ? { loading: true } : {}),
        };
      },
      act: async () => undefined,
    };
    let now = 0;
    const clock = {
      now: () => now,
      sleep: async (ms: number) => {
        now += ms;
      },
    };
    return { page, clock, walks: () => walks };
  };

  it("reads again while the page shows it is loading, until its controls stop changing", async () => {
    const { page, clock, walks } = signIn(3);
    const seen = await settled(page, {}, clock);
    expect(seen.controls.map((c) => c.label)).toEqual(["Email or Phone Number", "Continue"]);
    expect(seen.loading).toBeUndefined();
    expect(walks()).toBe(5);
  });

  it("reads once when nothing is loading, and says loading when the wait runs out", async () => {
    const quiet = signIn(0);
    await settled(quiet.page, {}, quiet.clock);
    expect(quiet.walks()).toBe(1);
    // Right after an open the old page is still up, loaded: it waits for the page asked for.
    const opened = signIn(0);
    let at = "https://example.com/old";
    const old = opened.page.observe.bind(opened.page);
    opened.page.observe = async (options) => {
      const seen = await old(options);
      if (opened.walks() === 3) at = "https://appstoreconnect.apple.com/login";
      return { ...seen, url: at };
    };
    expect(
      await settled(
        opened.page,
        {},
        opened.clock,
        (seen) => (seen.url ?? "").includes("appstoreconnect"),
        1_000,
      ),
    ).toMatchObject({ url: "https://appstoreconnect.apple.com/login" });
    expect(opened.walks()).toBe(4);
    const slow = signIn(1_000);

    expect(await settled(slow.page, {}, slow.clock)).toMatchObject({ loading: true, controls: [] });
  });
});

describe("navigationText", () => {
  it("takes the address a navigation goal names, as written, and nothing else", () => {
    expect(navigationText("open Chrome and go to example.com")).toBe("example.com");
    expect(navigationText("Navigate to https://example.com/docs?a=1.")).toBe(
      "https://example.com/docs?a=1",
    );
    expect(navigationText("open www.bbc.co.uk/news in Safari")).toBe("www.bbc.co.uk/news");
    expect(navigationText("visit github.com/jayleaton")).toBe("github.com/jayleaton");
    expect(navigationText("send the note to bob@example.com")).toBeNull();
    expect(navigationText("open Notes")).toBeNull();
    expect(navigationText("reply to the email from example.com")).toBeNull();
    expect(navigationText("open the email from paypal.com and click unsubscribe")).toBeNull();
    expect(navigationText("open the website example.org")).toBe("example.org");
    expect(navigationText("open Chrome and go to app.t3.codes")).toBe("app.t3.codes");
    expect(navigationText("go to localhost:3000/settings")).toBe("localhost:3000/settings");
    expect(navigationText("open notes.txt")).toBeNull();
  });

  it("calls a goal navigation only when nothing is left to do on the page", () => {
    expect(pureNavigation("open Chrome and go to example.com")).toBe(true);
    expect(pureNavigation("Open https://example.com in the user's default browser")).toBe(true);
    expect(pureNavigation("go to example.com and report the latest build")).toBe(false);
  });
});
