import type { LiveActivityLayout } from "expo-widgets";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@expo/ui/swift-ui", () => ({
  HStack: "HStack",
  Image: "Image",
  Spacer: "Spacer",
  Text: "Text",
  VStack: "VStack",
  ZStack: "ZStack",
}));

vi.mock("@expo/ui/swift-ui/modifiers", () => {
  const modifier = (value: unknown) => value;
  return {
    accessibilityElement: modifier,
    accessibilityLabel: modifier,
    activityBackgroundTint: modifier,
    font: modifier,
    foregroundStyle: modifier,
    frame: modifier,
    layoutPriority: modifier,
    lineLimit: modifier,
    minimumScaleFactor: modifier,
    padding: modifier,
    resizable: modifier,
    widgetURL: modifier,
  };
});

// Hand back the layout function so the test can render it with a chosen environment.
vi.mock("expo-widgets", () => ({
  createLiveActivity: (_name: string, layout: unknown) => layout,
}));

import AgentActivity, {
  type AgentActivityProps,
  type AgentActivityRowProps,
} from "./AgentActivity";

const render = AgentActivity as unknown as (
  props: AgentActivityProps,
  environment: unknown,
) => LiveActivityLayout;

function row(overrides: Partial<AgentActivityRowProps>): AgentActivityRowProps {
  return {
    environmentId: "env-1",
    threadId: "thread-1",
    projectTitle: "Project",
    threadTitle: "Thread",
    modelTitle: "Model",
    phase: "running",
    status: "Working",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deepLink: "/threads/env-1/thread-1",
    ...overrides,
  };
}

describe("AgentActivity", () => {
  it("drops the agent count from the expanded Dynamic Island once the activity is stale", () => {
    const layout = render(
      {
        title: "Agents",
        subtitle: "",
        activeCount: 2,
        updatedAt: "2026-01-01T00:00:00.000Z",
        activities: [row({}), row({ threadId: "thread-2", phase: "starting" })],
      },
      {
        colorScheme: "dark",
        isLuminanceReduced: false,
        isLiquidGlassAvailable: false,
        isStale: true,
        widgetRenderingMode: "fullColor",
      },
    );
    const expandedLeading = JSON.stringify(layout.expandedLeading);
    expect(expandedLeading).not.toContain('"children":"2"');
    expect(expandedLeading).toContain('"children":"Out of date"');
  });
});
