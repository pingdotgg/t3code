import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveProviderInstanceEntries } from "../../providerInstances";
import { adjacentModelPickerProvider } from "./modelPickerNavigation";

function entry(status: ServerProvider["status"], driver = "opencode") {
  return deriveProviderInstanceEntries([
    {
      instanceId: ProviderInstanceId.make(`${driver}_work`),
      driver: ProviderDriverKind.make(driver),
      enabled: true,
      installed: true,
      version: null,
      status,
      auth: { status: "authenticated" },
      checkedAt: "2026-08-28T00:00:00.000Z",
      models: [],
      slashCommands: [],
      skills: [],
    },
  ])[0]!;
}

describe("adjacentModelPickerProvider", () => {
  const codex = entry("ready", "codex");
  const claude = entry("ready", "claudeAgent");
  const unavailable = entry("error");
  const input = {
    entries: [codex, unavailable, claude],
    disabledInstanceIds: undefined,
    selectableUnavailableInstanceIds: undefined,
  };

  it("visits the Pareto line between favorites and the instances when shown", () => {
    const withPareto = { ...input, showPareto: true };
    expect(
      adjacentModelPickerProvider({ ...withPareto, selectedInstanceId: "favorites", direction: 1 }),
    ).toBe("pareto");
    expect(
      adjacentModelPickerProvider({ ...withPareto, selectedInstanceId: "pareto", direction: 1 }),
    ).toBe(codex.instanceId);
    expect(
      adjacentModelPickerProvider({ ...input, selectedInstanceId: "favorites", direction: 1 }),
    ).toBe(codex.instanceId);
  });
});
