import { describe, it, expect } from "vitest";
import { mapCodexCollabAgentToUnified, isUnifiedSubAgentToolCall } from "../integration.ts";

describe("SubAgent Integration Helpers", () => {
  describe("mapCodexCollabAgentToUnified", () => {
    it("should map spawnAgent to spawn action", () => {
      const result = mapCodexCollabAgentToUnified({
        action: "spawnAgent",
        config: {
          provider: "codex",
          model: "gpt-5.5",
          prompt: "Test task",
        },
      });

      expect(result).toEqual({
        action: "spawn",
        providerInstanceId: "codex",
        model: "gpt-5.5",
        prompt: "Test task",
      });
    });

    it("should map waitAgent to wait action", () => {
      const result = mapCodexCollabAgentToUnified({
        action: "waitAgent",
        agentId: "thread-123",
      });

      expect(result).toEqual({
        action: "wait",
        threadId: "thread-123",
      });
    });

    it("should map sendAgent to send action", () => {
      const result = mapCodexCollabAgentToUnified({
        action: "sendAgent",
        agentId: "thread-123",
        config: {
          prompt: "Follow-up task",
        },
      });

      expect(result).toEqual({
        action: "send",
        threadId: "thread-123",
        prompt: "Follow-up task",
      });
    });

    it("should return null for invalid action", () => {
      const result = mapCodexCollabAgentToUnified({
        action: "unknownAction",
      });

      expect(result).toBeNull();
    });

    it("should return null for missing required fields", () => {
      const result = mapCodexCollabAgentToUnified({
        action: "spawnAgent",
        // Missing config
      });

      expect(result).toBeNull();
    });
  });

  describe("isUnifiedSubAgentToolCall", () => {
    it("should recognize subagent tool", () => {
      expect(isUnifiedSubAgentToolCall("subagent")).toBe(true);
      expect(isUnifiedSubAgentToolCall("unified_subagent")).toBe(true);
    });

    it("should reject other tools", () => {
      expect(isUnifiedSubAgentToolCall("bash")).toBe(false);
      expect(isUnifiedSubAgentToolCall("read")).toBe(false);
      expect(isUnifiedSubAgentToolCall("agent_spawn")).toBe(false);
    });
  });
});
