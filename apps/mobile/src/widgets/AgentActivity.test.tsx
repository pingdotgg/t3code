import { isValidElement } from "react";
import { expect, it, vi } from "vite-plus/test";

import { AgentActivity, type AgentActivityProps } from "./AgentActivity";

vi.mock("expo-widgets", () => ({
  createLiveActivity: () => ({}),
  createWidget: () => ({}),
}));
vi.mock("@expo/ui/swift-ui", () => ({
  Divider: "Divider",
  HStack: "HStack",
  Image: "Image",
  Text: "Text",
  Spacer: "Spacer",
  VStack: "VStack",
  ZStack: "ZStack",
}));
vi.mock("@expo/ui/swift-ui/modifiers", () =>
  Object.fromEntries(
    [
      "accessibilityElement",
      "accessibilityLabel",
      "activityBackgroundTint",
      "containerBackground",
      "aspectRatio",
      "font",
      "foregroundStyle",
      "frame",
      "layoutPriority",
      "lineLimit",
      "minimumScaleFactor",
      "multilineTextAlignment",
      "padding",
      "resizable",
      "widgetURL",
    ].map((name) => [name, (value: unknown) => ({ name, value })]),
  ),
);

it.each([-1, 0, 1])(
  "does not infer completion from five capped terminal rows: active=%s",
  (activeCount) => {
    const activity: AgentActivityProps = {
      title: "T3 Code",
      subtitle: "",
      activeCount,
      isExpired: true,
      updatedAt: "2026-10-28T10:00:00Z",
      activities: Array.from({ length: 5 }, (_, index) => ({
        environmentId: "environment",
        threadId: String(index),
        projectTitle: "Project",
        threadTitle: "Finished task",
        modelTitle: "Codex",
        phase: "completed",
        status: "Done",
        updatedAt: "2026-10-28T10:00:00Z",
        deepLink: "/",
      })),
    };
    const compact = AgentActivity(activity, { colorScheme: "dark" }).compactTrailing;
    expect(isValidElement(compact)).toBe(true);
    if (!isValidElement<{ children: string }>(compact)) return;
    expect(compact.props.children).toBe(activeCount === 0 ? "Done" : "Out of date");
  },
);
