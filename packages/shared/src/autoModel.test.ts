import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { AUTO_LEVEL_DESCRIPTOR, isAutoModelSlug, resolveAutoModelSelection } from "./autoModel.ts";

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

function withWeekly(provider: ServerProvider, usedPercent: number, weeklyResetsAt: string) {
  return {
    ...provider,
    usageLimits: {
      windows: [
        ...(provider.usageLimits?.windows ?? []),
        { id: "seven_day", kind: "weekly", label: "Weekly", usedPercent, resetsAt: weeklyResetsAt },
      ],
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

  it("routes to the account with less of its 5-hour window used", () => {
    // A has the busier week but a nearly unused 5-hour window, so it can take work right now.
    const providers = [
      withWeekly(claude("claudeAutoB", 50), 20, "2026-11-18T12:00:00.000Z"),
      withWeekly(claude("claudeAuto", 10), 60, "2026-11-18T12:00:00.000Z"),
    ];
    expect(
      resolveAutoModelSelection({ selection: auto(), providers, now })?.selection.instanceId,
    ).toBe("claudeAuto");
  });

  it("with similar 5-hour use, spends the account whose weekly limit resets first", () => {
    // B has slightly less 5-hour use, but A's unused weekly quota is gone tomorrow.
    const providers = [
      withWeekly(claude("claudeAutoB", 25), 40, "2026-11-18T12:00:00.000Z"),
      withWeekly(claude("claudeAuto", 30), 40, "2026-11-13T12:00:00.000Z"),
    ];
    expect(
      resolveAutoModelSelection({ selection: auto(), providers, now })?.selection.instanceId,
    ).toBe("claudeAuto");
  });

  it("falls back to Claude on the Antigravity subscription before other providers", () => {
    const antigravity = {
      ...claude("antigravity", 0, false),
      driver: ProviderDriverKind.make("antigravity"),
      models: ["claude-opus-4-6-thinking", "claude-sonnet-4-6"].map((slug) => ({
        slug,
        name: slug,
        isCustom: false,
        capabilities: {
          optionDescriptors: [
            {
              id: "thinking_level",
              label: "Thinking",
              type: "select" as const,
              options: ["low", "medium", "high"].map((id) => ({ id, label: id })),
            },
          ],
        },
      })),
    } as unknown as ServerProvider;
    const providers = [claude("claudeAuto", 100), claude("claudeAutoB", 100), antigravity];
    expect(resolveAutoModelSelection({ selection: auto(), providers, now })?.selection).toEqual({
      instanceId: "antigravity",
      model: "claude-opus-4-6-thinking",
      options: [{ id: "thinking_level", value: "medium" }],
    });
  });

  it("reads the level from auto-low / auto-medium / auto-high", () => {
    const providers = [claude("claudeAuto", 10)];
    const pick = (model: string) =>
      resolveAutoModelSelection({
        selection: { instanceId: ProviderInstanceId.make("claudeAuto"), model },
        providers,
        now,
      })?.selection.model;
    expect(pick("auto-high")).toBe("claude-fable-5-2");
    expect(pick("auto-medium")).toBe("claude-opus-5-5");
    expect(pick("auto-low")).toBe("claude-sonnet-5-5");
    expect(isAutoModelSlug("auto-low")).toBe(true);
    expect(isAutoModelSlug("auto-max")).toBe(false);
  });

  it("returns null when nothing is usable", () => {
    const providers = [claude("claudeAuto", 100), claude("claudeAutoB", 100)];
    expect(resolveAutoModelSelection({ selection: auto(), providers, now })).toBeNull();
  });
});
