import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { isValidElement, type ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import type { AgentActivityRowProps } from "../AgentActivity";
import { OverviewWidget } from "./OverviewWidget";
import { WorkLiveActivity } from "./WorkLiveActivity";

vi.mock("@expo/ui/swift-ui", () => ({
  Divider: "Divider",
  HStack: "HStack",
  Image: "Image",
  Link: "Link",
  Spacer: "Spacer",
  Text: "Text",
  VStack: "VStack",
}));
vi.mock("@expo/ui/swift-ui/modifiers", () => {
  const noop = () => undefined;
  return {
    accessibilityLabel: noop,
    activityBackgroundTint: noop,
    contentShape: noop,
    font: noop,
    foregroundStyle: noop,
    frame: noop,
    layoutPriority: noop,
    lineLimit: noop,
    monospacedDigit: noop,
    padding: noop,
    privacySensitive: noop,
    resizable: noop,
    shapes: { rectangle: noop },
    widgetAccentedRenderingMode: noop,
    widgetURL: (url: string) => url,
  };
});
vi.mock("expo-widgets", () => ({
  createWidget: () => null,
  createLiveActivity: () => null,
}));

function childrenOf(
  node: ReactNode,
  type: string,
  property: "destination" | "modifiers" | "children",
): unknown[] {
  if (Array.isArray(node))
    return node.flatMap((child: ReactNode) => childrenOf(child, type, property));
  if (!isValidElement<{ children?: ReactNode; destination?: string; modifiers?: unknown[] }>(node))
    return [];
  return [
    ...(node.type === type ? [node.props[property]] : []),
    ...childrenOf(node.props.children, type, property),
  ];
}

const activeRow = {
  environmentId: EnvironmentId.make("remote"),
  threadId: ThreadId.make("working"),
  projectTitle: "Project",
  threadTitle: "Build fix",
  phase: "running",
  deepLink: "/threads/remote/working",
  updatedAt: "2026-11-20T12:00:00.000Z",
  modelTitle: "Model",
} as const;

it("renders the iPad gallery placeholder before WidgetKit has saved props", () => {
  const widget = OverviewWidget(undefined, {
    widgetFamily: "systemExtraLarge",
    configuration: { view: "overview" },
  });
  expect(childrenOf(widget, "Text", "children")).toContain("Open PseudoCode to refresh");
});

it("gives iPad recent rows individual destinations beside active work", () => {
  const recent = ["first", "second", "third"].map((threadId) => ({
    ...activeRow,
    threadId: ThreadId.make(threadId),
    deepLink: `/threads/remote/${threadId}`,
  }));
  const widget = OverviewWidget(
    {
      appScheme: "t3code-dev",
      activeCount: 8,
      attentionCount: 3,
      approvalCount: 2,
      activities: [{ ...activeRow, headline: "Working" }],
      work: { recent, review: [], finished: 0, failed: 0 },
    },
    { widgetFamily: "systemExtraLarge", configuration: { view: "overview" } },
  );
  expect(childrenOf(widget, "Link", "destination")).toEqual([
    "t3code-dev://threads/remote/working",
    ...recent.map((row) => `t3code-dev://${row.deepLink.slice(1)}`),
  ]);
  expect(childrenOf(widget, "Text", "children")).toEqual(
    expect.arrayContaining([
      "5",
      "Working",
      "3",
      "Need you",
      "Approvals",
      "Questions",
      "Recent threads",
    ]),
  );
});

it("uses pushed statuses in recents and marks omitted working threads as last known", () => {
  const completed = { ...activeRow, phase: "completed" as const, headline: "Done" };
  const missing = {
    ...activeRow,
    threadId: ThreadId.make("missing"),
    threadTitle: "Unverified run",
    deepLink: "/threads/remote/missing",
  };
  const widget = OverviewWidget(
    {
      activities: [completed],
      work: { recent: [activeRow, missing], review: [], finished: 0, failed: 0 },
    },
    { widgetFamily: "systemLarge", configuration: { view: "recent" } },
  );
  const content = childrenOf(widget, "Text", "children");
  expect(content).toEqual(expect.arrayContaining(["Completed", "Last known"]));
  expect(content).not.toContain("Working");
  expect(childrenOf(widget, "VStack", "modifiers")[0]).toContain("t3code://");
});

it("leads the Live Activity with attention and removes the active count when stale", () => {
  const approval: AgentActivityRowProps = {
    ...activeRow,
    threadId: "approval",
    threadTitle: "Needs a decision",
    deepLink: "/threads/remote/approval",
    phase: "waiting_for_approval",
    status: "Approval needed",
  };
  const props = {
    appScheme: "t3code-dev",
    title: "Activity",
    subtitle: "Work",
    updatedAt: activeRow.updatedAt,
    activeCount: 6,
    activities: [{ ...activeRow, status: "Working" }, approval],
  };
  const environment = {
    isStale: false,
    isLiquidGlassAvailable: false,
    colorScheme: "dark",
  } as const;
  const live = WorkLiveActivity(props, environment);
  expect(childrenOf(live.banner, "Text", "children")).toContain("Needs a decision");
  expect(childrenOf(live.banner, "Link", "destination")).toEqual([
    "t3code-dev://threads/remote/approval",
  ]);
  expect(childrenOf(live.expandedBottom, "Link", "destination")).toEqual([
    "t3code-dev://threads/remote/approval",
  ]);
  expect(childrenOf(live.compactTrailing, "Text", "children")).toEqual(["1"]);
  const stale = WorkLiveActivity(props, { ...environment, isStale: true });
  expect(childrenOf(stale.banner, "Text", "children")).toEqual(["Agent status out of date"]);
  expect(childrenOf(stale.compactTrailing, "Text", "children")).toEqual([]);
});
