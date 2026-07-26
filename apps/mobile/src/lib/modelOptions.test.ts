import { describe, expect, it } from "vite-plus/test";

import { ProviderInstanceId, type ServerConfig } from "@t3tools/contracts";

import { buildModelDisplayNameMap, buildModelOptions, groupByProvider } from "./modelOptions";

describe("mobile model options", () => {
  it("flattens catalog names across provider instances", () => {
    const config = {
      providers: [
        {
          instanceId: "claude",
          models: [{ slug: "claude-sonnet-5", name: "Sonnet 5" }],
        },
        {
          instanceId: "codex",
          models: [{ slug: "gpt-5.6-luna", name: "GPT-5.6 Luna" }],
        },
      ],
    } as unknown as ServerConfig;

    const displayNames = buildModelDisplayNameMap(config);

    expect(displayNames.get("claude-sonnet-5")).toBe("Sonnet 5");
    expect(displayNames.get("gpt-5.6-luna")).toBe("GPT-5.6 Luna");
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

  it("uses contracts display names for every driver kind and falls back to the instance id", () => {
    const makeProvider = (driver: string, instanceId: string) => ({
      instanceId,
      driver,
      enabled: true,
      installed: true,
      auth: { status: "authenticated" },
      models: [{ slug: `${driver}-model`, name: `${driver} model` }],
    });
    const config = {
      providers: [
        makeProvider("claudex", "claudex"),
        makeProvider("chatgpt", "chatgpt"),
        makeProvider("kimi", "kimi"),
        makeProvider("grok", "grok"),
        makeProvider("some-future-driver", "future-instance"),
      ],
    } as unknown as ServerConfig;

    const groups = groupByProvider(buildModelOptions(config, null));
    const labels = new Map(groups.map((group) => [group.providerKey, group.providerLabel]));

    expect(labels.get("claudex")).toBe("Claude Code");
    expect(labels.get("chatgpt")).toBe("ChatGPT");
    expect(labels.get("kimi")).toBe("Kimi");
    expect(labels.get("grok")).toBe("Grok");
    expect(labels.get("future-instance")).toBe("future-instance");
  });

  it("treats missing availability as available and hides unavailable instances", () => {
    const config = {
      providers: [
        {
          instanceId: "codex",
          driver: "codex",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: [{ slug: "gpt-test", name: "GPT Test" }],
        },
        {
          instanceId: "ghost",
          driver: "ghost-driver",
          enabled: false,
          installed: false,
          availability: "unavailable",
          unavailableReason: "Driver not shipped in this build",
          auth: { status: "authenticated" },
          models: [{ slug: "ghost-model", name: "Ghost Model" }],
        },
      ],
    } as unknown as ServerConfig;

    const options = buildModelOptions(config, null);

    expect(options.map((option) => option.providerKey)).toEqual(["codex"]);
  });
});
