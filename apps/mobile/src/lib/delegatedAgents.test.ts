import { describe, expect, it } from "vite-plus/test";

import { hasDelegatedAgentTitle } from "./delegatedAgents";

describe("hasDelegatedAgentTitle", () => {
  it("accepts only the exact Agent title prefix", () => {
    expect(hasDelegatedAgentTitle("Agent: researcher")).toBe(true);
    expect(hasDelegatedAgentTitle("Agent:x")).toBe(false);
    expect(hasDelegatedAgentTitle("agent: researcher")).toBe(false);
    expect(hasDelegatedAgentTitle("My Agent: researcher")).toBe(false);
    expect(hasDelegatedAgentTitle(" Agent: researcher")).toBe(false);
  });
});
