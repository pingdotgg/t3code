import { describe, expect, it } from "vite-plus/test";

import { ProviderInstanceId, type ServerConfig } from "@t3tools/contracts";

import { buildModelOptions } from "./modelOptions";

describe("mobile model options", () => {
  it("uses OpenCode sub-provider names to distinguish duplicate model labels", () => {
    const config = {
      providers: [
        {
          instanceId: "opencode",
          driver: "opencode",
          displayName: "OpenCode",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: [
            {
              slug: "anthropic/claude-sonnet-4-5",
              name: "Claude Sonnet 4.5",
              subProvider: "Anthropic",
              isCustom: false,
              capabilities: null,
            },
            {
              slug: "github-copilot/claude-sonnet-4-5",
              name: "Claude Sonnet 4.5",
              subProvider: "GitHub Copilot",
              isCustom: false,
              capabilities: null,
            },
          ],
        },
      ],
    } as unknown as ServerConfig;

    const options = buildModelOptions(config, null);

    expect(options.map((option) => [option.label, option.subtitle])).toEqual([
      ["Claude Sonnet 4.5", "Anthropic"],
      ["Claude Sonnet 4.5", "GitHub Copilot"],
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
});
