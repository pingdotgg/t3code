import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { AgentActivityPhase } from "./AgentActivity";
import type { AgentStatusSnapshot, AgentStatusThread } from "./agentStatusSnapshot";

vi.mock("expo-widgets", () => ({
  createWidget: (_name: string, layout: unknown) => layout,
  createLiveActivity: (_name: string, layout: unknown) => layout,
}));
vi.mock("@expo/ui/swift-ui", () => ({
  AccessoryWidgetBackground: "AccessoryWidgetBackground",
  HStack: "HStack",
  Image: "Image",
  Link: "Link",
  Spacer: "Spacer",
  Text: "Text",
  VStack: "VStack",
  ZStack: "ZStack",
}));
vi.mock("@expo/ui/swift-ui/modifiers", () => {
  const modifier =
    (name: string) =>
    (...args: ReadonlyArray<unknown>) => ({ name, args });
  return {
    Animation: { easeOut: (params: unknown) => ({ animation: "easeOut", params }) },
    shapes: { roundedRectangle: (params: unknown) => ({ shape: "roundedRectangle", params }) },
    ...Object.fromEntries(
      [
        "accessibilityElement",
        "accessibilityLabel",
        "activityBackgroundTint",
        "animation",
        "background",
        "containerBackground",
        "contentTransition",
        "environment",
        "font",
        "foregroundStyle",
        "frame",
        "layoutPriority",
        "lineLimit",
        "padding",
        "resizable",
        "truncationMode",
        "widgetURL",
      ].map((name) => [name, modifier(name)]),
    ),
  };
});

const { default: AgentStatus } = await import("./AgentStatus");
const { default: AgentActivity } = await import("./AgentActivity");
const layout = AgentStatus as unknown as (
  props: Partial<AgentStatusSnapshot> | undefined,
  environment: Record<string, unknown>,
) => unknown;

interface Node {
  readonly type: unknown;
  readonly props: {
    readonly children?: unknown;
    readonly modifiers?: ReadonlyArray<{ name: string; args: ReadonlyArray<unknown> }>;
    readonly systemName?: string;
    readonly destination?: string;
  };
}

function* walk(node: unknown): Generator<Node> {
  if (Array.isArray(node)) {
    for (const child of node) yield* walk(child);
    return;
  }
  if (!node || typeof node !== "object" || !("props" in node)) return;
  yield node as Node;
  yield* walk((node as Node).props.children);
}

function modifierArgs(node: unknown, name: string): ReadonlyArray<unknown> {
  return [...walk(node)].flatMap((element) =>
    (element.props.modifiers ?? []).filter((m) => m.name === name).map((m) => m.args[0]),
  );
}

function text(node: unknown): string {
  return [...walk(node)]
    .filter((element) => element.type === "Text")
    .map((element) => [element.props.children].flat().join(""))
    .join(" ");
}

function firstMark(node: unknown): string {
  const element = [...walk(node)].find(
    (candidate) => candidate.props.systemName || candidate.type === "Text",
  );
  return element?.props.systemName ?? text(element);
}

const CHECKED_AT = Date.parse("2026-10-31T18:41:00.000Z");
const FRESH = new Date(CHECKED_AT + 60_000);
const EXPIRED = new Date(CHECKED_AT + 5 * 60_000);
// A time of day in any timezone, not a date: the snapshot is minutes old.
const AS_OF = String.raw`As of \d{1,2}:\d{2}`;

const GLANCE_FAMILIES = [
  "systemSmall",
  "accessoryCircular",
  "accessoryRectangular",
  "accessoryInline",
] as const;
const FAMILIES = [
  "systemSmall",
  "systemMedium",
  "systemLarge",
  "accessoryCircular",
  "accessoryRectangular",
  "accessoryInline",
] as const;

function env(widgetFamily: (typeof FAMILIES)[number], date = FRESH) {
  return { widgetFamily, date, colorScheme: "dark", widgetRenderingMode: "fullColor" };
}

function thread(title: string, phase: AgentActivityPhase): AgentStatusThread {
  const slug = title.toLowerCase().replaceAll(" ", "-");
  return { title, project: "T3 Code", phase, url: `t3code-dev://threads/moonbase/${slug}` };
}

function snapshot(
  threads: ReadonlyArray<AgentStatusThread>,
  counts: AgentStatusSnapshot["counts"],
): AgentStatusSnapshot {
  return {
    url: "t3code-dev://",
    checkedAt: CHECKED_AT,
    expiresAt: CHECKED_AT + 5 * 60_000,
    counts,
    threads,
  };
}

const handoff = (phase: AgentActivityPhase) =>
  snapshot([thread("Fix login redirect", phase), thread("Update snapshots", "completed")], {
    needsYou: 1,
    working: 0,
    failed: 0,
    done: 1,
  });

describe("AgentStatus widget", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(CHECKED_AT);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ["approval", "waiting_for_approval", "Needs approval", "Fix login redirect needs approval"],
    ["input", "waiting_for_input", "Needs your input", "Fix login redirect needs your input"],
  ] as const)(
    "leads every family with the thread that needs %s and opens it",
    (_name, phase, need, spoken) => {
      const fixLogin = "t3code-dev://threads/moonbase/fix-login-redirect";
      for (const family of ["systemSmall", "accessoryCircular", "accessoryRectangular"] as const) {
        const view = layout(handoff(phase), env(family));
        expect(modifierArgs(view, "widgetURL"), family).toEqual([fixLogin]);
        const labels = modifierArgs(view, "accessibilityLabel");
        expect(labels, family).toHaveLength(1);
        expect(labels[0], family).toMatch(
          new RegExp(`^${spoken}\\. 1 needs you, 1 done\\. ${AS_OF}`),
        );
      }
      expect(text(layout(handoff(phase), env("systemSmall")))).toContain(need);
      expect(text(layout(handoff(phase), env("accessoryInline")))).toContain(
        "1 needs you · 1 done",
      );

      const stack = layout(handoff(phase), env("systemMedium"));
      const rows = [...walk(stack)].filter((element) => element.type === "Link");
      expect(rows.map((element) => element.props.destination)).toEqual([
        fixLogin,
        "t3code-dev://threads/moonbase/update-snapshots",
      ]);
      // The thread that needs the user is the raised tab, not only a colored row.
      expect(modifierArgs(rows[0], "background")).toHaveLength(1);
      expect(modifierArgs(rows[1], "background")).toHaveLength(0);
      expect(modifierArgs(rows[0], "accessibilityLabel")).toEqual([`${spoken}, T3 Code`]);
      expect(modifierArgs(rows[1], "accessibilityLabel")).toEqual([
        "Update snapshots is done, T3 Code",
      ]);
    },
  );

  it("gives VoiceOver a label in every family and state", () => {
    const states = {
      handoff: handoff("waiting_for_approval"),
      empty: snapshot([], { needsYou: 0, working: 0, failed: 0, done: 0 }),
      unpublished: undefined,
    };
    for (const family of FAMILIES) {
      for (const [state, props] of Object.entries(states)) {
        const labels = modifierArgs(layout(props, env(family)), "accessibilityLabel");
        expect(labels.length, `${family} ${state}`).toBeGreaterThan(0);
        expect(labels.every((label) => typeof label === "string" && label.length > 0)).toBe(true);
      }
    }
  });

  it("shows the empty state instead of a blank card", () => {
    const empty = snapshot([], { needsYou: 0, working: 0, failed: 0, done: 0 });
    for (const family of FAMILIES) {
      const view = layout(empty, env(family));
      expect(text(view), family).toContain("›");
      expect(modifierArgs(view, "accessibilityLabel").join(" "), family).toContain(
        "No agents running",
      );
    }
    expect(modifierArgs(layout(empty, env("systemSmall")), "widgetURL")).toEqual(["t3code-dev://"]);
    expect(text(layout(undefined, env("systemSmall")))).toContain(
      "Open T3 Code to see your agents",
    );
  });

  it("stops claiming work or requests once the snapshot is old", () => {
    const props = snapshot(
      [
        thread("Fix login redirect", "waiting_for_approval"),
        thread("Polish copy", "running"),
        thread("Update snapshots", "completed"),
      ],
      { needsYou: 1, working: 1, failed: 0, done: 1 },
    );
    for (const family of FAMILIES) {
      const view = layout(props, env(family, EXPIRED));
      const words = `${text(view)} ${modifierArgs(view, "accessibilityLabel").join(" ")}`;
      expect(words, family).not.toMatch(/working|needs you|needs approval/i);
      expect(words, family).toMatch(/out of date/i);
      const symbols = [...walk(view)].map((element) => element.props.systemName);
      expect(symbols, family).toContain("clock.arrow.circlepath");
      expect(symbols, family).not.toContain("exclamationmark.shield.fill");
    }
    const stack = text(layout(props, env("systemLarge", EXPIRED)));
    expect(stack).toContain("Done");
    expect(stack).toMatch(new RegExp(AS_OF));
  });

  it("takes counts from the data and says how many rows did not fit", () => {
    const threads = [
      thread("Fix login redirect", "waiting_for_input"),
      ...Array.from({ length: 7 }, (_, index) => thread(`Working ${index}`, "running")),
    ];
    const props = snapshot(threads, { needsYou: 1, working: 10, failed: 0, done: 0 });

    const medium = layout(props, env("systemMedium"));
    expect(text(medium)).toContain("1 needs you · 10 working");
    expect([...walk(medium)].filter((element) => element.type === "Link")).toHaveLength(2);
    expect(text(medium)).toContain("+9 more");

    const large = layout(props, env("systemLarge"));
    expect([...walk(large)].filter((element) => element.type === "Link")).toHaveLength(8);
    expect(text(large)).toContain("+3 more");

    expect(text(layout(props, env("accessoryCircular")))).toBe("›? 1");
  });

  it("uses the Live Activity's mark for each of the seven phases", () => {
    const phases: ReadonlyArray<AgentActivityPhase> = [
      "starting",
      "running",
      "waiting_for_approval",
      "waiting_for_input",
      "completed",
      "failed",
      "stale",
    ];
    const liveActivity = AgentActivity as unknown as (
      props: unknown,
      environment: Record<string, unknown>,
    ) => Record<string, unknown>;
    for (const phase of phases) {
      const widgetMark = firstMark(
        layout(
          snapshot([thread("Thread", phase)], { needsYou: 0, working: 0, failed: 0, done: 0 }),
          env("systemSmall"),
        ),
      );
      const activityMark = firstMark(
        liveActivity(
          {
            title: "T3 Code",
            subtitle: "",
            activeCount: 1,
            updatedAt: "",
            activities: [
              {
                environmentId: "moonbase",
                threadId: "thread",
                projectTitle: "T3 Code",
                threadTitle: "Thread",
                modelTitle: "",
                phase,
                status: "Status",
                updatedAt: "",
                deepLink: "/threads/moonbase/thread",
              },
            ],
          },
          { colorScheme: "dark" },
        ).minimal,
      );
      expect(widgetMark, phase).toBe(activityMark);
    }
  });

  it("leads with a failure once the snapshot is old, as the Live Activity does", () => {
    const props = snapshot(
      [
        thread("Fix login redirect", "waiting_for_approval"),
        thread("Flaky test", "failed"),
        thread("Update snapshots", "completed"),
      ],
      { needsYou: 1, working: 0, failed: 1, done: 1 },
    );
    for (const family of GLANCE_FAMILIES) {
      const view = layout(props, env(family, EXPIRED));
      expect(modifierArgs(view, "accessibilityLabel")[0], family).toMatch(/^Flaky test failed/);
    }
    const rows = [...walk(layout(props, env("systemMedium", EXPIRED)))].filter(
      (element) => element.type === "Link",
    );
    expect(rows[0]?.props.destination).toBe("t3code-dev://threads/moonbase/flaky-test");
  });

  it("renders a phase this build does not know as out of date in every family", () => {
    const props = snapshot([thread("Fix login redirect", "cancelled" as AgentActivityPhase)], {
      needsYou: 0,
      working: 0,
      failed: 0,
      done: 2,
    });
    for (const family of GLANCE_FAMILIES) {
      const view = layout(props, env(family));
      expect(modifierArgs(view, "accessibilityLabel")[0], family).toMatch(
        /^Fix login redirect status is out of date/,
      );
    }
    for (const family of ["systemMedium", "systemLarge"] as const) {
      expect(text(layout(props, env(family))), family).toContain("Out of date");
    }
    expect(text(layout(props, env("accessoryCircular")))).not.toContain("2");
  });
});
