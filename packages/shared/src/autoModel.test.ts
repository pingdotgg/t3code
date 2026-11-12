import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { AUTO_LEVEL_DESCRIPTOR, resolveAutoModelSelection } from "./autoModel.ts";

const now = Date.parse("2026-11-12T12:00:00.000Z");
const resetsAt = "2026-11-12T15:00:00.000Z";

const effortCapabilities = {
  optionDescriptors: [
    {
      id: "effort",
      label: "Effort",
      type: "select" as const,
      options: ["low", "medium", "high"].map((id) => ({ id, label: id })),
    },
  ],
};

function claude(id: string, usedPercent: number, autoAware = true): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(id),
    driver: ProviderDriverKind.make("claudeAgent"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-11-12T11:00:00.000Z",
    models: [
      ...["claude-fable-5-2", "claude-opus-5-5", "claude-sonnet-5-5"].map((slug) => ({
        slug,
        name: slug,
        isCustom: false,
        capabilities: effortCapabilities,
      })),
      ...(autoAware
        ? [
            {
              slug: "auto",
              name: "Auto",
              isCustom: true,
              capabilities: { optionDescriptors: [AUTO_LEVEL_DESCRIPTOR] },
            },
          ]
        : []),
    ],
    slashCommands: [],
    skills: [],
    usageLimits: {
      windows: [{ id: "five_hour", kind: "session", label: "Session", usedPercent, resetsAt }],
    },
  } as unknown as ServerProvider;
}

const auto = (level?: string): ModelSelection => ({
  instanceId: ProviderInstanceId.make("claudeAuto"),
  model: "auto",
  ...(level ? { options: [{ id: "effort", value: level }] } : {}),
});

describe("resolveAutoModelSelection", () => {
  it("maps each level to its orchestrator model and effort, medium by default", () => {
    const providers = [claude("claudeAuto", 10)];
    expect(
      resolveAutoModelSelection({ selection: auto("high"), providers, now })?.selection,
    ).toEqual({
      instanceId: "claudeAuto",
      model: "claude-fable-5-2",
      options: [{ id: "effort", value: "high" }],
    });
    expect(resolveAutoModelSelection({ selection: auto(), providers, now })?.selection.model).toBe(
      "claude-opus-5-5",
    );
    expect(
      resolveAutoModelSelection({ selection: auto("low"), providers, now })?.selection,
    ).toEqual({
      instanceId: "claudeAuto",
      model: "claude-sonnet-5-5",
      options: [{ id: "effort", value: "low" }],
    });
  });

  it("picks the Claude account with more room, preferring Auto-aware instances", () => {
    const providers = [
      claude("claudeAgent", 0, false),
      claude("claudeAuto", 70),
      claude("claudeAutoB", 20),
    ];
    expect(
      resolveAutoModelSelection({ selection: auto("medium"), providers, now })?.selection
        .instanceId,
    ).toBe("claudeAutoB");
  });

  it("keeps the thread's current model until it passes 90% used", () => {
    const current = { instanceId: ProviderInstanceId.make("claudeAuto"), model: "claude-opus-5-5" };
    const calm = [claude("claudeAuto", 60), claude("claudeAutoB", 5)];
    expect(
      resolveAutoModelSelection({ selection: auto(), providers: calm, now, current }),
    ).toMatchObject({ sticky: true, selection: { instanceId: "claudeAuto" } });

    const busy = [claude("claudeAuto", 95), claude("claudeAutoB", 5)];
    expect(
      resolveAutoModelSelection({ selection: auto(), providers: busy, now, current }),
    ).toMatchObject({ sticky: false, selection: { instanceId: "claudeAutoB" } });
  });

  it("steps down to other subscriptions when both Claude accounts are exhausted", () => {
    const grok = {
      ...claude("grok", 0, false),
      driver: ProviderDriverKind.make("grok"),
      models: [{ slug: "grok-4.7", name: "Grok 4.7", isCustom: false, capabilities: null }],
      usageLimits: undefined,
    } as unknown as ServerProvider;
    const providers = [claude("claudeAuto", 100), claude("claudeAutoB", 100), grok];
    expect(resolveAutoModelSelection({ selection: auto(), providers, now })?.selection).toEqual({
      instanceId: "grok",
      model: "grok-4.7",
    });
  });

  it("returns null when nothing is usable", () => {
    const providers = [claude("claudeAuto", 100), claude("claudeAutoB", 100)];
    expect(resolveAutoModelSelection({ selection: auto(), providers, now })).toBeNull();
  });
});
