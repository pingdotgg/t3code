import { describe, expect, it, vi } from "vitest";

vi.mock("@expo/ui/swift-ui", () => ({
  HStack: "HStack",
  Spacer: "Spacer",
  Text: "Text",
  VStack: "VStack",
}));

vi.mock("@expo/ui/swift-ui/modifiers", () => ({
  font: (value: unknown) => value,
  foregroundStyle: (value: unknown) => value,
  lineLimit: (value: unknown) => value,
  padding: (value: unknown) => value,
}));

vi.mock("expo-widgets", () => ({
  createLiveActivity: vi.fn((name: string, layout: unknown) => ({ layout, name })),
}));

import { AgentActivity, type AgentActivityProps } from "./AgentActivity";

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

describe("AgentActivity widget layout", () => {
  it("formats its updated-at label without app-runtime helper references", () => {
    expect(JSON.stringify(AgentActivity(props, environment as never))).toContain(
      '"children":["Updated ","1:07"]',
    );
    expect(AgentActivity.toString()).not.toContain("formatAgentActivityUpdatedAtLabel");
  });

  it("uses now when the updated-at timestamp is malformed", () => {
    expect(
      JSON.stringify(AgentActivity({ ...props, updatedAt: "not-a-date" }, environment as never)),
    ).toContain('"children":["Updated ","now"]');
  });
});
