import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_CLAUDE_CODEX_ROUTING_SETTINGS,
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";

import { buildClaudeCodexRoutingPatch, readClaudeCodexRouting } from "./ModelRoutingSettings.logic";

describe("ModelRoutingSettings logic", () => {
  it("reads and updates the legacy default Claude instance", () => {
    const id = ProviderInstanceId.make("claudeAgent");
    const routing = { ...DEFAULT_CLAUDE_CODEX_ROUTING_SETTINGS, enabled: true };
    expect(buildClaudeCodexRoutingPatch(DEFAULT_SERVER_SETTINGS, id, routing)).toEqual({
      providers: { claudeAgent: { codexRouting: routing } },
    });
  });

  it("preserves an explicit instance envelope and config", () => {
    const id = ProviderInstanceId.make("claude_work");
    const settings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [id]: {
          driver: ProviderDriverKind.make("claudeAgent"),
          displayName: "Claude Work",
          config: { homePath: "/tmp/claude", codexRouting: { enabled: true } },
        },
      },
    };
    expect(readClaudeCodexRouting(settings, id).enabled).toBe(true);
    const routing = {
      ...DEFAULT_CLAUDE_CODEX_ROUTING_SETTINGS,
      model: "gpt-test",
    };
    expect(buildClaudeCodexRoutingPatch(settings, id, routing).providerInstances?.[id]).toEqual({
      driver: "claudeAgent",
      displayName: "Claude Work",
      config: { homePath: "/tmp/claude", codexRouting: routing },
    });
  });
});
