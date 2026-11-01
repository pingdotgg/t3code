import type { LiveActivityComponent } from "expo-widgets";
import { isValidElement } from "react";
import { expect, it, vi } from "vite-plus/test";

import activity, { type AgentActivityProps, type AgentActivityRowProps } from "./AgentActivity.tsx";

vi.mock("expo-widgets", () => ({
  createLiveActivity: (_name: string, render: LiveActivityComponent) => render,
}));
vi.mock("@expo/ui/swift-ui", () => ({
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

it("targets the first displayed attention thread when incoming rows are unordered", () => {
  const render = activity as unknown as LiveActivityComponent<AgentActivityProps>;
  const older: AgentActivityRowProps = {
    environmentId: "environment",
    threadId: "older",
    projectTitle: "Project",
    threadTitle: "Older request",
    modelTitle: "Codex",
    phase: "waiting_for_approval",
    status: "Approval needed",
    updatedAt: "2026-10-28T09:00:00Z",
    deepLink: "/threads/environment/older",
  };
  const newer = {
    ...older,
    threadId: "newer",
    phase: "woke" as const,
    updatedAt: "2026-10-28T10:00:00Z",
    deepLink: "/threads/environment/newer",
  };
  const layout = render(
    {
      title: "Agents",
      subtitle: "",
      activeCount: 2,
      updatedAt: newer.updatedAt,
      activities: [older, newer],
    },
    { colorScheme: "dark" },
  );
  const compact = layout.compactTrailing;
  expect(isValidElement(compact)).toBe(true);
  if (!isValidElement<{ children: string; modifiers: unknown[] }>(compact)) return;
  expect(compact.props.children).toBe("Woke");
  expect(compact.props.modifiers).toContainEqual({
    name: "widgetURL",
    value: "t3code://threads/environment/newer",
  });
  expect(layout.minimal).toMatchObject({
    props: {
      children: { props: { systemName: "alarm.fill" } },
      modifiers: expect.arrayContaining([
        { name: "widgetURL", value: "t3code://threads/environment/newer" },
      ]),
    },
  });
});
