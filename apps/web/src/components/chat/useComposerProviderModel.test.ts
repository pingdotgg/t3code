import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { describe, expect, it } from "vite-plus/test";

import { resolveComposerSendForPick } from "./useComposerProviderModel";

describe("resolveComposerSendForPick", () => {
  const instanceId = ProviderInstanceId.make("codex");
  const model = "gpt-6.2-sol";
  const codex: ServerProvider = {
    instanceId,
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [
      {
        slug: model,
        name: model,
        isCustom: false,
        capabilities: {
          optionDescriptors: [
            {
              id: "reasoningEffort",
              label: "Reasoning",
              type: "select",
              options: [
                { id: "low", label: "Low", isDefault: true },
                { id: "high", label: "High" },
              ],
              currentValue: "low",
            },
          ],
        },
      },
    ],
    slashCommands: [],
    skills: [],
  };
  const stored = { instanceId, model, options: [{ id: "reasoningEffort", value: "high" }] };
  const input: Parameters<typeof resolveComposerSendForPick>[0] = {
    providerStatuses: [codex],
    settings: DEFAULT_UNIFIED_SETTINGS,
    activeProjectId: null,
    threadRef: "draft" as Parameters<typeof resolveComposerSendForPick>[0]["threadRef"],
    threadModelSelection: stored,
    projectModelSelection: null,
    promptInjectionState: "none",
    threadStarted: true,
    candidateInstanceIds: [instanceId],
    lockedProvider: null,
    lockedInstanceId: null,
  };

  it("sends the picked options over the thread's stored ones", () => {
    const pick = { instanceId, model, options: [{ id: "reasoningEffort", value: "low" }] };

    expect(resolveComposerSendForPick(input, pick)).toEqual(pick);
  });

  it("keeps the stored options for a pick without any, as a send before the save does", () => {
    expect(resolveComposerSendForPick(input, { instanceId, model })).toEqual(stored);
  });
});
