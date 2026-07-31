import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@expo/ui/swift-ui", () => ({
  Capsule: "Capsule",
  Circle: "Circle",
  HStack: "HStack",
  Image: "Image",
  Spacer: "Spacer",
  Text: "Text",
  VStack: "VStack",
  ZStack: "ZStack",
}));

vi.mock("@expo/ui/swift-ui/modifiers", () => ({
  aspectRatio: (value: unknown) => value,
  background: (color: unknown, shape: unknown) => ({ background: color, shape }),
  font: (value: unknown) => value,
  foregroundStyle: (value: unknown) => value,
  frame: (value: unknown) => value,
  kerning: (value: unknown) => value,
  layoutPriority: (value: unknown) => value,
  lineLimit: (value: unknown) => value,
  padding: (value: unknown) => value,
  resizable: (value: unknown) => value,
  shapes: {
    capsule: (value?: unknown) => ({ shape: "capsule", value }),
    roundedRectangle: (value: unknown) => ({ shape: "roundedRectangle", value }),
  },
  widgetURL: (value: unknown) => ({ widgetURL: value }),
}));

vi.mock("expo-widgets", () => ({
  createLiveActivity: vi.fn((name: string, layout: unknown) => ({ layout, name })),
}));

import {
  AgentActivity,
  type AgentActivityProps,
  type AgentActivityRowProps,
} from "./AgentActivity";

function makeRow(overrides: Partial<AgentActivityRowProps>): AgentActivityRowProps {
  return {
    environmentId: "env-1",
    threadId: "thread-1",
    projectTitle: "Project",
    threadTitle: "Thread",
    providerName: "codex",
    modelTitle: "gpt-5.4",
    phase: "running",
    status: "Working",
    updatedAt: "2026-05-25T13:07:00.000Z",
    deepLink: "/threads/env-1/thread-1",
    ...overrides,
  };
}

const props = {
  title: "T3 Code",
  subtitle: "Agent work in progress",
  activeCount: 1,
  updatedAt: "2026-05-25T13:07:00.000Z",
  activities: [],
} satisfies AgentActivityProps;

const environment = {
  colorScheme: "dark",
  isLuminanceReduced: false,
} as const;

const lightEnvironment = {
  colorScheme: "light",
  isLuminanceReduced: false,
} as const;

describe("AgentActivity widget layout", () => {
  it("tints each row by its own phase using the dark palette", () => {
    const layout = AgentActivity(
      {
        ...props,
        activeCount: 2,
        activities: [
          makeRow({}),
          makeRow({ threadId: "thread-2", phase: "waiting_for_approval", status: "Approval" }),
        ],
      },
      environment as never,
    );
    const banner = JSON.stringify(layout.banner);
    expect(banner).toContain("#64d2ff"); // systemCyan (dark): running
    expect(banner).toContain("#ff9f0a"); // systemOrange (dark): waiting_for_approval
  });

  it("switches to the light-material palette when the scheme is light", () => {
    // macOS (iPhone Mirroring / Mac notification center) renders the activity
    // on a light background; the dark-material palette is illegible there.
    const layout = AgentActivity(
      {
        ...props,
        activeCount: 2,
        activities: [
          makeRow({}),
          makeRow({ threadId: "thread-2", phase: "waiting_for_approval", status: "Approval" }),
        ],
      },
      lightEnvironment as never,
    );
    const banner = JSON.stringify(layout.banner);
    expect(banner).toContain("#32ade6"); // systemCyan (light): running
    expect(banner).toContain("#ff9500"); // systemOrange (light): waiting_for_approval
    expect(banner).not.toContain("#64d2ff");
    expect(banner).not.toContain("#ff9f0a");
  });

  it("orders rows attention-first in the banner", () => {
    const layout = AgentActivity(
      {
        ...props,
        activeCount: 2,
        activities: [
          makeRow({ threadTitle: "Working thread" }),
          makeRow({
            threadId: "thread-2",
            threadTitle: "Blocked thread",
            phase: "waiting_for_approval",
            status: "Approval",
          }),
        ],
      },
      environment as never,
    );
    const banner = JSON.stringify(layout.banner);
    expect(banner.indexOf("Blocked thread")).toBeGreaterThan(-1);
    expect(banner.indexOf("Blocked thread")).toBeLessThan(banner.indexOf("Working thread"));
  });

  it("summarizes the attention count in the banner header", () => {
    const layout = AgentActivity(
      {
        ...props,
        activeCount: 3,
        activities: [
          makeRow({}),
          makeRow({ threadId: "thread-2", phase: "waiting_for_input", status: "Input" }),
        ],
      },
      environment as never,
    );
    const banner = JSON.stringify(layout.banner);
    expect(banner).toContain("3 active agents");
    expect(banner).toContain("1 needs attention");
  });

  it("uses a dedicated compact hierarchy for the Watch Smart Stack", () => {
    const layout = AgentActivity(
      {
        ...props,
        activeCount: 3,
        activities: [
          makeRow({
            threadTitle: "Prepare App Store release",
            projectTitle: "T3 Code",
            phase: "waiting_for_approval",
            status: "Approval",
          }),
          makeRow({ threadId: "thread-2" }),
          makeRow({ threadId: "thread-3" }),
        ],
      },
      environment as never,
    );
    const watch = JSON.stringify(layout.bannerSmall);

    expect(watch).toContain("Needs attention");
    expect(watch).not.toContain("1 needs attention");
    expect(watch).toContain("Prepare App Store release");
    expect(watch).toContain("T3 Code");
    expect(watch).toContain("Approval");
    expect(watch).toContain("+2 more");
    expect(watch).not.toContain("#111214");
  });

  it("uses the attention tint for the compact presentations when a row needs input", () => {
    const layout = AgentActivity(
      {
        ...props,
        activeCount: 2,
        activities: [
          makeRow({}),
          makeRow({ threadId: "thread-2", phase: "waiting_for_input", status: "Input" }),
        ],
      },
      environment as never,
    );
    expect(JSON.stringify(layout.compactLeading)).toContain("#ff9f0a"); // systemOrange (dark)
    expect(JSON.stringify(layout.compactTrailing)).toContain("Input");
    expect(JSON.stringify(layout.minimal)).toContain("#ff9f0a");
  });

  it("deep links the banner to the row that needs attention", () => {
    const layout = AgentActivity(
      {
        ...props,
        activeCount: 2,
        activities: [
          makeRow({}),
          makeRow({
            threadId: "thread-2",
            phase: "waiting_for_approval",
            status: "Approval",
            deepLink: "/threads/env-1/thread-2",
          }),
        ],
      },
      environment as never,
    );
    expect(JSON.stringify(layout.banner)).toContain(
      '"widgetURL":"t3code://threads/env-1/thread-2"',
    );
  });

  it("deep links the banner to the first row when nothing needs attention", () => {
    const layout = AgentActivity({ ...props, activities: [makeRow({})] }, environment as never);
    expect(JSON.stringify(layout.banner)).toContain(
      '"widgetURL":"t3code://threads/env-1/thread-1"',
    );
  });

  it("omits the deep link for unsafe paths and empty aggregates", () => {
    expect(JSON.stringify(AgentActivity(props, environment as never))).not.toContain("widgetURL");
    expect(
      JSON.stringify(
        AgentActivity(
          { ...props, activities: [makeRow({ deepLink: "//evil.example" })] },
          environment as never,
        ),
      ),
    ).not.toContain("widgetURL");
  });

  it("leads with the outcome instead of a zero count when nothing is active", () => {
    const layout = AgentActivity(
      {
        ...props,
        subtitle: "Agent work completed",
        activeCount: 0,
        activities: [makeRow({ phase: "completed", status: "Done" })],
      },
      environment as never,
    );
    const banner = JSON.stringify(layout.banner);
    expect(banner).toContain("Agent work completed");
    expect(banner).not.toContain("0 active");
    expect(banner).toContain("#30d158"); // systemGreen (dark) header tint
    expect(JSON.stringify(layout.compactTrailing)).toContain("Done");
    expect(JSON.stringify(layout.compactTrailing)).not.toContain("0 active");
    expect(JSON.stringify(layout.expandedLeading)).toContain("Done");
    expect(JSON.stringify(layout.minimal)).toContain("checkmark.circle.fill");
    expect(JSON.stringify(layout.bannerSmall)).toContain("Done");
  });

  it("reads Failed when the finished work ended in failure", () => {
    const layout = AgentActivity(
      {
        ...props,
        subtitle: "Agent work failed",
        activeCount: 0,
        activities: [makeRow({ phase: "failed", status: "Failed" })],
      },
      environment as never,
    );
    const banner = JSON.stringify(layout.banner);
    expect(banner).toContain("Agent work failed");
    expect(banner).toContain("#ff453a"); // systemRed (dark) header tint
    expect(JSON.stringify(layout.compactTrailing)).toContain("Failed");
    expect(JSON.stringify(layout.expandedLeading)).toContain("Failed");
    expect(JSON.stringify(layout.minimal)).toContain("xmark.octagon.fill");
  });

  it("lets a failure dominate mixed finished outcomes across every presentation", () => {
    const layout = AgentActivity(
      {
        ...props,
        // The server subtitle keys off the newest terminal row (completed
        // here); the layout must still read Failed everywhere so the header
        // text never disagrees with the tint, count slots, or minimal glyph.
        subtitle: "Agent work completed",
        activeCount: 0,
        activities: [
          makeRow({ phase: "completed", status: "Done" }),
          makeRow({ threadId: "thread-2", phase: "failed", status: "Failed" }),
        ],
      },
      environment as never,
    );
    const banner = JSON.stringify(layout.banner);
    expect(banner).toContain("Agent work failed");
    expect(banner).not.toContain("Agent work completed");
    expect(banner).toContain("#ff453a"); // systemRed (dark) header tint
    expect(JSON.stringify(layout.compactTrailing)).toContain("Failed");
    expect(JSON.stringify(layout.expandedLeading)).toContain("Failed");
    expect(JSON.stringify(layout.minimal)).toContain("xmark.octagon.fill");
  });

  it("shows four rows and counts off the rest", () => {
    const layout = AgentActivity(
      {
        ...props,
        activeCount: 6,
        activities: [1, 2, 3, 4, 5].map((n) =>
          makeRow({ threadId: `t${n}`, threadTitle: `Thread ${n}` }),
        ),
      },
      environment as never,
    );
    const banner = JSON.stringify(layout.banner);
    // One line per agent fits four in the expanded island's ~110pt of content
    // height; silently dropping the fifth would read as "that's all".
    for (const visible of [1, 2, 3, 4]) {
      expect(banner).toContain(`Thread ${visible}`);
    }
    expect(banner).not.toContain("Thread 5");
    expect(banner).toContain("+2 more");
    const expanded = JSON.stringify(layout.expandedBottom);
    expect(expanded).toContain("Thread 4");
    expect(expanded).not.toContain("Thread 5");
    expect(expanded).toContain("+2 more");
    expect(JSON.stringify(layout.bannerSmall)).toContain("+5 more");
  });

  it("uses provider identity instead of inferring the icon from the model", () => {
    const layout = AgentActivity(
      {
        ...props,
        activeCount: 2,
        activities: [
          makeRow({ providerName: "cursor", modelTitle: "gpt-5.4" }),
          makeRow({
            threadId: "thread-2",
            providerName: "claudeAgent",
            modelTitle: "gpt-5.4",
          }),
        ],
      },
      environment as never,
    );
    const banner = JSON.stringify(layout.banner);
    expect(banner).toContain('"assetName":"Cursor"');
    expect(banner).toContain('"assetName":"Claude"');
    expect(banner).not.toContain('"assetName":"Codex"');
  });

  it("aspect-fits provider marks inside their fixed layout slots", () => {
    const layout = AgentActivity(
      {
        ...props,
        activities: [makeRow({ providerName: "cursor" })],
      },
      environment as never,
    );

    const banner = JSON.stringify(layout.banner);
    expect(banner).toContain('"assetName":"Cursor"');
    expect(banner).toContain('"width":11,"height":11');
    expect(banner).toContain('"contentMode":"fit"');

    const watch = JSON.stringify(layout.bannerSmall);
    expect(watch).toContain('"assetName":"Cursor"');
    expect(watch).toContain('"width":13,"height":13');
    expect(watch).toContain('"contentMode":"fit"');
  });

  it("keeps active work dominant while a recent failed row remains", () => {
    const layout = AgentActivity(
      {
        ...props,
        activeCount: 1,
        activities: [
          makeRow({
            threadId: "failed",
            threadTitle: "Recently failed",
            phase: "failed",
            status: "Failed",
          }),
          makeRow({
            threadId: "active",
            threadTitle: "Still working",
            phase: "running",
            status: "Working",
          }),
        ],
      },
      environment as never,
    );

    expect(JSON.stringify(layout.compactLeading)).toContain("#64d2ff");
    expect(JSON.stringify(layout.compactLeading)).not.toContain("#ff453a");
    expect(JSON.stringify(layout.compactTrailing)).toContain("Working");
    expect(JSON.stringify(layout.compactTrailing)).not.toContain("Failed");
    expect(JSON.stringify(layout.minimal)).not.toContain("xmark.octagon.fill");

    const watch = JSON.stringify(layout.bannerSmall);
    expect(watch).toContain("Agents active");
    expect(watch).toContain("Still working");
    expect(watch).not.toContain("Agent failed");
    expect(watch).not.toContain("Recently failed");
  });

  it("names the project on every row so each one says where it is working", () => {
    const layout = AgentActivity(
      {
        ...props,
        activeCount: 2,
        activities: [
          makeRow({ threadId: "a", projectTitle: "Portfolio" }),
          makeRow({ threadId: "b", projectTitle: "Notch" }),
        ],
      },
      environment as never,
    );
    const banner = JSON.stringify(layout.banner);
    expect(banner).toContain("Portfolio");
    expect(banner).toContain("Notch");
  });

  it("keeps the phase colour in the dot and leaves the headline plain", () => {
    const layout = AgentActivity(
      { ...props, activities: [makeRow({ phase: "waiting_for_approval", status: "Approval" })] },
      environment as never,
    );
    // The strip label is white; only the dot and per-card status carry the tint,
    // so a glance reads phase from one place.
    const trailing = JSON.stringify(layout.compactTrailing);
    expect(trailing).toContain("Approval");
    expect(trailing).not.toContain("#ff9f0a");
    expect(JSON.stringify(layout.compactLeading)).toContain("#ff9f0a");
  });
  it("reads out the phase in both island pills, terse enough not to truncate", () => {
    const layout = AgentActivity(
      { ...props, activities: [makeRow({ phase: "waiting_for_approval", status: "Approval" })] },
      environment as never,
    );
    // Each island region is only ~50pt wide; the long form truncated to
    // "Needs a...", so the pill uses the same word the row status does.
    expect(JSON.stringify(layout.expandedLeading)).toContain("Approval");
    expect(JSON.stringify(layout.compactTrailing)).toContain("Approval");
    expect(JSON.stringify(layout.expandedLeading)).not.toContain("Needs approval");
  });

  it("shows the agent count pill on both shoulders once more than one is running", () => {
    const busy = AgentActivity(
      { ...props, activeCount: 3, activities: [makeRow({}), makeRow({ threadId: "thread-2" })] },
      environment as never,
    );
    expect(JSON.stringify(busy.expandedTrailing)).toContain('"3"');
    expect(JSON.stringify(busy.compactTrailing)).toContain('"3"');
    // Not on the banner though: its headline already reads "3 active agents",
    // so a count on the shoulder would just be the same number twice.
    expect(JSON.stringify(busy.banner)).toContain("3 active agents");
    expect(JSON.stringify(busy.banner)).not.toContain('"3"');

    const single = AgentActivity({ ...props, activities: [makeRow({})] }, environment as never);
    expect(single.expandedTrailing).toBeNull();
    expect(JSON.stringify(single.compactTrailing)).not.toContain('"1"');
  });

  it("renders every row on the same neutral slab", () => {
    const layout = AgentActivity(
      {
        ...props,
        activeCount: 2,
        activities: [
          makeRow({}),
          makeRow({ threadId: "thread-2", phase: "waiting_for_input", status: "Input" }),
        ],
      },
      environment as never,
    );
    const expanded = JSON.stringify(layout.expandedBottom);
    expect(expanded).toContain("roundedRectangle");
    // Every row sits on the same neutral slab. Tinting the blocked ones muddied
    // the card without adding anything the dot and status do not already say.
    expect(expanded).toContain("#8e8e9333");
    expect(expanded).not.toContain("#ff9f0a29");
    // The phase still reads from the dot and the status label.
    expect(expanded).toContain("#ff9f0a");
    // The provider mark leads each row in place of the model text.
    expect(expanded).toContain("Codex");
  });

  it("keeps the count as plain text, since no island region renders a fill", () => {
    const busy = AgentActivity(
      { ...props, activeCount: 3, activities: [makeRow({}), makeRow({ threadId: "t2" })] },
      environment as never,
    );
    const trailing = JSON.stringify(busy.expandedTrailing);
    expect(trailing).toContain('"3"');
    expect(trailing).not.toContain("capsule");
  });

  it("keeps every banner child flat, since nested arrays are dropped natively", () => {
    // expo-widgets' JSX stub stores children exactly as given, with none of
    // React's flattening. [strip, [cards]] made the rows unreachable and the
    // lock screen rendered the strip alone, so the children must stay flat.
    const layout = AgentActivity(
      {
        ...props,
        activeCount: 2,
        activities: [makeRow({}), makeRow({ threadId: "t2", threadTitle: "Second" })],
      },
      environment as never,
    );
    for (const region of [layout.banner, layout.bannerSmall, layout.expandedBottom]) {
      const children = (region as { props: { children: unknown } }).props.children;
      expect(Array.isArray(children)).toBe(true);
      for (const child of children as ReadonlyArray<unknown>) {
        expect(Array.isArray(child)).toBe(false);
      }
    }
    expect(JSON.stringify(layout.banner)).toContain("Second");
  });
});
