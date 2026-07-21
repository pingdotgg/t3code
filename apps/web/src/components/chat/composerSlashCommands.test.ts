import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ProviderInstanceEntry } from "../../providerInstances";
import { buildComposerSlashCommandItems } from "./composerSlashCommands";
import { collectComposerSlashCommands } from "~/lib/composerSlashCommands";

function makeProviderInstanceEntry(input: {
  instanceId: string;
  driverKind: string;
  slashCommands: Array<{ name: string; description?: string; hint?: string }>;
}): ProviderInstanceEntry {
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driverKind: ProviderDriverKind.make(input.driverKind),
    displayName: input.driverKind,
    enabled: true,
    installed: true,
    status: "ready",
    isDefault: true,
    isAvailable: true,
    snapshot: {
      instanceId: ProviderInstanceId.make(input.instanceId),
      driver: ProviderDriverKind.make(input.driverKind),
      displayName: input.driverKind,
      enabled: true,
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "unknown" },
      checkedAt: "2025-01-01T00:00:00.000Z",
      models: [],
      slashCommands: input.slashCommands.map((command) => ({
        name: command.name,
        ...(command.description ? { description: command.description } : {}),
        ...(command.hint ? { input: { hint: command.hint } } : {}),
      })),
      skills: [],
    } as ProviderInstanceEntry["snapshot"],
    models: [],
  };
}

describe("buildComposerSlashCommandItems", () => {
  it("includes slash commands from multiple providers", () => {
    const items = buildComposerSlashCommandItems([
      makeProviderInstanceEntry({
        instanceId: "claude-agent",
        driverKind: "claudeAgent",
        slashCommands: [{ name: "ui", description: "Explore and refine UI" }],
      }),
      makeProviderInstanceEntry({
        instanceId: "codex",
        driverKind: "codex",
        slashCommands: [
          { name: "plan", description: "Create an implementation plan" },
          { name: "apply", hint: "Apply the current change" },
        ],
      }),
    ]);

    expect(items.map((item) => item.id)).toEqual([
      "slash:model",
      "slash:plan",
      "slash:default",
      "provider-slash-command:claude-agent:ui",
      "provider-slash-command:codex:apply",
    ]);
    expect(items.filter((item) => item.type === "provider-slash-command")).toEqual([
      expect.objectContaining({
        label: "Ui",
        description: "Explore and refine UI",
      }),
      expect.objectContaining({
        label: "Apply",
        description: "Apply the current change",
      }),
    ]);
  });

  it("hides commands disabled in settings", () => {
    const providerInstances = [
      makeProviderInstanceEntry({
        instanceId: "claude-agent",
        driverKind: "claudeAgent",
        slashCommands: [
          { name: "ui", description: "Explore and refine UI" },
          { name: "docs", description: "Update docs" },
        ],
      }),
    ];

    expect(
      collectComposerSlashCommands(
        providerInstances.map((entry) => entry.snapshot),
        {
          hiddenSlashCommandsByProvider: {
            "claude-agent": ["ui"],
          },
        },
      ).map((command) => command.name),
    ).toEqual(["model", "plan", "default", "docs"]);

    expect(
      buildComposerSlashCommandItems(providerInstances, {
        "claude-agent": ["ui"],
      }).map((item) => item.id),
    ).toEqual([
      "slash:model",
      "slash:plan",
      "slash:default",
      "provider-slash-command:claude-agent:docs",
    ]);
  });
});
