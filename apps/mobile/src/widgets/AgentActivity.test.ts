import { describe, expect, it, vi } from "vite-plus/test";

import type {
  AgentActivityPhase,
  AgentActivityProps,
  AgentActivityRowProps,
} from "./AgentActivity";

vi.mock("expo-widgets", () => ({ createLiveActivity: (_name: string, layout: unknown) => layout }));
vi.mock("@expo/ui/swift-ui", () => ({
  HStack: "HStack",
  Image: "Image",
  Spacer: "Spacer",
  Text: "Text",
  VStack: "VStack",
}));
vi.mock("@expo/ui/swift-ui/modifiers", () => {
  const modifier =
    (name: string) =>
    (...args: ReadonlyArray<unknown>) => ({ name, args });
  return {
    Animation: { easeOut: (params: unknown) => ({ animation: "easeOut", params }) },
    ...Object.fromEntries(
      [
        "accessibilityElement",
        "accessibilityLabel",
        "activityBackgroundTint",
        "animation",
        "contentTransition",
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

const { default: AgentActivity } = await import("./AgentActivity");
const layout = AgentActivity as unknown as (
  props: AgentActivityProps,
  environment: Record<string, unknown>,
) => Record<string, unknown>;

interface Node {
  readonly type: unknown;
  readonly props: {
    readonly children?: unknown;
    readonly modifiers?: ReadonlyArray<{ name: string; args: ReadonlyArray<unknown> }>;
    readonly systemName?: string;
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

const dark = { colorScheme: "dark" };

function row(threadId: string, threadTitle: string, phase: AgentActivityPhase, status: string) {
  return {
    environmentId: "moonbase-terminal",
    threadId,
    projectTitle: "T3 Code",
    threadTitle,
    modelTitle: "GPT-6.1",
    phase,
    status,
    updatedAt: "2026-10-31T17:41:00.000Z",
    deepLink: `/threads/moonbase-terminal/${threadId}`,
  } satisfies AgentActivityRowProps;
}

function activity(
  activeCount: number,
  activities: ReadonlyArray<AgentActivityRowProps>,
): AgentActivityProps {
  return {
    title: "T3 Code",
    subtitle: "Agent work in progress",
    activeCount,
    updatedAt: "2026-10-31T17:42:00.000Z",
    activities,
  };
}

const SECTIONS = ["banner", "bannerSmall", "compactLeading", "compactTrailing", "minimal"];

describe("AgentActivity", () => {
  it.each([
    ["approval", "waiting_for_approval", "Approval", "Fix login redirect needs approval"],
    ["input", "waiting_for_input", "Input", "Fix login redirect needs your input"],
  ] as const)(
    "leads every presentation with the thread that needs %s when another finishes",
    (_name, phase, status, spoken) => {
      const sections = layout(
        activity(1, [
          row("update-snapshots", "Update snapshots", "completed", "Done"),
          row("fix-login-redirect", "Fix login redirect", phase, status),
        ]),
        dark,
      );

      for (const section of [...SECTIONS, "expandedBottom"]) {
        expect(modifierArgs(sections[section], "widgetURL"), section).toEqual([
          "t3code://threads/moonbase-terminal/fix-login-redirect",
        ]);
      }
      expect(modifierArgs(sections.minimal, "accessibilityLabel")).toEqual([
        `${spoken}. 1 needs you, 1 done`,
      ]);
      expect(text(sections.compactTrailing)).toContain(status);
      expect(modifierArgs(sections.banner, "accessibilityLabel")[0]).toBe(
        `T3 Code. ${spoken}, T3 Code. Update snapshots is done, T3 Code`,
      );
    },
  );

  it("gives each of the seven phases its own resting mark", () => {
    const phases: ReadonlyArray<AgentActivityPhase> = [
      "starting",
      "running",
      "waiting_for_approval",
      "waiting_for_input",
      "completed",
      "failed",
      "stale",
    ];
    const marks = phases.map((phase) => {
      const minimal = layout(activity(1, [row("t", "Thread", phase, "Status")]), {
        ...dark,
        widgetRenderingMode: "vibrant",
      }).minimal;
      const symbol = [...walk(minimal)].find((element) => element.props.systemName);
      return symbol?.props.systemName ?? text(minimal);
    });
    expect(new Set(marks).size).toBe(phases.length);
  });

  it("stops claiming agents work once the content is stale", () => {
    const sections = layout(
      activity(2, [
        row("fix-login-redirect", "Fix login redirect", "running", "Working"),
        row("update-snapshots", "Update snapshots", "waiting_for_input", "Input"),
      ]),
      { ...dark, isStale: true },
    );

    expect(text(sections.banner)).toContain("Out of date");
    expect(text(sections.banner)).not.toMatch(/working|needs you/i);
    expect(modifierArgs(sections.minimal, "accessibilityLabel")[0]).toContain(
      "status is out of date",
    );
  });

  it("does not count threads the relay reports as stale as working", () => {
    const sections = layout(
      activity(2, [
        row("fix-login-redirect", "Fix login redirect", "stale", "Waiting"),
        row("update-snapshots", "Update snapshots", "stale", "Waiting"),
      ]),
      dark,
    );

    expect(text(sections.banner)).toContain("Out of date");
    expect(text(sections.banner)).not.toMatch(/working/i);
  });

  it("counts working agents from activeCount, not the rows that fit", () => {
    const sections = layout(
      activity(7, [
        row("a", "A", "waiting_for_approval", "Approval"),
        row("b", "B", "waiting_for_input", "Input"),
        row("c", "C", "running", "Working"),
        row("d", "D", "running", "Working"),
        row("e", "E", "failed", "Failed"),
      ]),
      dark,
    );

    expect(text(sections.banner)).toContain("2 need you · 5 working · 1 failed");
    expect(text(sections.banner)).toContain("+1 more");
  });
});
