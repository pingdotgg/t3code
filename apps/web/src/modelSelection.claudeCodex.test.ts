import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { describe, expect, it } from "vite-plus/test";

import {
  getAppModelOptionsForInstance,
  resolveAppModelSelectionForInstance,
} from "./modelSelection";
import { deriveProviderInstanceEntries } from "./providerInstances";

const CLAUDE_INSTANCE_ID = ProviderInstanceId.make("claudeAgent");

const provider: ServerProvider = {
  instanceId: CLAUDE_INSTANCE_ID,
  driver: ProviderDriverKind.make("claudeAgent"),
  enabled: true,
  installed: true,
  version: "2.1.219",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-08-06T00:00:00.000Z",
  models: [
    {
      slug: "claude-opus-5",
      name: "Claude Opus 5",
      isCustom: false,
      capabilities: null,
    },
    {
      slug: "gpt-5.6-sol",
      name: "GPT-5.6 Sol",
      shortName: "GPT-5.6 Sol",
      subProvider: "via Codex",
      isCustom: false,
      capabilities: null,
    },
  ],
  slashCommands: [],
  skills: [],
};

describe("Claude Codex picker route", () => {
  it("keeps the routed identity and resolves it on the Claude instance", () => {
    const entry = deriveProviderInstanceEntries([provider])[0]!;
    const options = getAppModelOptionsForInstance(DEFAULT_UNIFIED_SETTINGS, entry);
    expect(options).toContainEqual({
      slug: "gpt-5.6-sol",
      name: "GPT-5.6 Sol",
      shortName: "GPT-5.6 Sol",
      subProvider: "via Codex",
      isCustom: false,
    });
    expect(
      resolveAppModelSelectionForInstance(
        CLAUDE_INSTANCE_ID,
        DEFAULT_UNIFIED_SETTINGS,
        [provider],
        "gpt-5.6-sol",
      ),
    ).toBe("gpt-5.6-sol");
  });
});
