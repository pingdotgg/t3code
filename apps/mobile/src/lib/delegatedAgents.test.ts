import { describe, expect, it } from "vite-plus/test";

import { isDelegatedAgentThread } from "./delegatedAgents";

describe("isDelegatedAgentThread", () => {
  it("matches the exact Agent title prefix", () => {
    expect(isDelegatedAgentThread({ title: "Agent: researcher" })).toBe(true);
    expect(isDelegatedAgentThread({ title: "Agent:x" })).toBe(false);
    expect(isDelegatedAgentThread({ title: "agent: researcher" })).toBe(false);
    expect(isDelegatedAgentThread({ title: "My Agent: researcher" })).toBe(false);
    expect(isDelegatedAgentThread({ title: " Agent: researcher" })).toBe(false);
  });

  it("matches a persisted parent link regardless of title", () => {
    expect(isDelegatedAgentThread({ title: "Renamed worker", parentThreadId: "parent-1" })).toBe(
      true,
    );
    expect(isDelegatedAgentThread({ title: "Regular session", parentThreadId: null })).toBe(false);
    expect(isDelegatedAgentThread({ title: "Regular session" })).toBe(false);
  });
});
