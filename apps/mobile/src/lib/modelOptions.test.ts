import { describe, expect, it } from "vite-plus/test";

import { ProviderInstanceId, type ServerConfig } from "@t3tools/contracts";

import {
  buildModelOptions,
  groupByProvider,
  resolveDefaultableModelSelection,
  resolveSelectableModelSelection,
  selectedProviderShowsInteractionModeToggle,
} from "./modelOptions";

describe("mobile model options", () => {
  it("preserves the upstream provider for OMP model rows", () => {
    const config = {
      providers: [
        {
          instanceId: "omp",
          driver: "omp",
          displayName: "Oh My Pi",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: [
            {
              slug: "moonshot/kimi-k2.6",
              name: "Kimi K2.6",
              subProvider: "Moonshot",
              isCustom: false,
              capabilities: null,
            },
          ],
        },
      ],
    } as unknown as ServerConfig;

    expect(buildModelOptions(config, null)).toMatchObject([
      {
        label: "Kimi K2.6",
        providerLabel: "Oh My Pi",
        subProvider: "Moonshot",
        subtitle: "Oh My Pi · Moonshot",
      },
    ]);
  });

  it("groups models by provider and flags legacy entries", () => {
    const config = {
      providers: [
        {
          instanceId: "codex",
          driver: "codex",
          displayName: "Codex",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: [
            {
              slug: "gpt-5.6-sol",
              name: "GPT-5.6 Sol",
              isCustom: false,
              capabilities: null,
            },
            {
              slug: "gpt-5.4",
              name: "GPT-5.4",
              isCustom: false,
              isLegacy: true,
              capabilities: null,
            },
          ],
        },
      ],
    } as unknown as ServerConfig;

    expect(groupByProvider(buildModelOptions(config, null))).toMatchObject([
      {
        providerKey: "codex",
        providerLabel: "Codex",
        models: [
          { key: "codex:gpt-5.6-sol", label: "GPT-5.6 Sol", isLegacy: false },
          { key: "codex:gpt-5.4", label: "GPT-5.4", isLegacy: true },
        ],
      },
    ]);
  });

  it("normalizes a legacy fallback selection against current capabilities", () => {
    const config = {
      providers: [
        {
          instanceId: "codex",
          driver: "codex",
          displayName: "Codex",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: [
            {
              slug: "gpt-test",
              name: "GPT Test",
              isCustom: false,
              capabilities: {
                optionDescriptors: [
                  {
                    id: "serviceTier",
                    label: "Service Tier",
                    type: "select",
                    options: [
                      { id: "default", label: "Standard", isDefault: true },
                      { id: "priority", label: "Fast" },
                    ],
                    currentValue: "default",
                  },
                ],
              },
            },
          ],
        },
      ],
    } as unknown as ServerConfig;

    const [option] = buildModelOptions(config, {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-test",
      options: [{ id: "fastMode", value: true }],
    });

    expect(option?.capabilities?.optionDescriptors?.[0]?.id).toBe("serviceTier");
    expect(option?.selection.options).toEqual([{ id: "serviceTier", value: "default" }]);
  });

  it("rejects stored selections whose provider is not usable", () => {
    const config = {
      providers: [
        {
          instanceId: "codex",
          driver: "codex",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: [],
        },
        {
          instanceId: "claudeAgent",
          driver: "claudeAgent",
          enabled: false,
          installed: true,
          auth: { status: "authenticated" },
          models: [],
        },
      ],
    } as unknown as ServerConfig;

    const usable = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.6-sol",
    };
    const disabled = {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-sonnet-5",
    };
    const removed = {
      instanceId: ProviderInstanceId.make("codex_personal"),
      model: "gpt-5.6-sol",
    };

    expect(resolveSelectableModelSelection(config, usable)).toBe(usable);
    expect(resolveSelectableModelSelection(config, disabled)).toBeNull();
    expect(resolveSelectableModelSelection(config, removed)).toBeNull();
    // No config (environment offline) — nothing to validate against.
    expect(resolveSelectableModelSelection(null, disabled)).toBe(disabled);
  });

  it("keeps legacy models out of implicit defaults", () => {
    const config = {
      providers: [
        {
          instanceId: "codex",
          driver: "codex",
          displayName: "Codex",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: [
            { slug: "gpt-5.6-sol", name: "GPT-5.6 Sol", isCustom: false, capabilities: null },
            {
              slug: "gpt-5.4",
              name: "GPT-5.4",
              isCustom: false,
              isLegacy: true,
              capabilities: null,
            },
          ],
        },
      ],
    } as unknown as ServerConfig;

    const current = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" };
    const legacy = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };

    expect(resolveDefaultableModelSelection(config, current)).toBe(current);
    // A legacy last-used selection falls through to the provider default.
    expect(resolveDefaultableModelSelection(config, legacy)).toBeNull();
    // Offline: nothing to validate against, selection passes through.
    expect(resolveDefaultableModelSelection(null, legacy)).toBe(legacy);
  });

  it("uses the selected provider interaction-mode capability", () => {
    const config = {
      providers: [
        {
          instanceId: "omp",
          driver: "omp",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          showInteractionModeToggle: false,
          models: [],
        },
      ],
    } as unknown as ServerConfig;
    const ompSelection = {
      instanceId: ProviderInstanceId.make("omp"),
      model: "moonshot/kimi-k2.6",
    };
    const missingSelection = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.6-sol",
    };

    expect(selectedProviderShowsInteractionModeToggle(config, ompSelection)).toBe(false);
    expect(selectedProviderShowsInteractionModeToggle(config, missingSelection)).toBe(true);
    expect(selectedProviderShowsInteractionModeToggle(null, ompSelection)).toBe(true);
  });
});
