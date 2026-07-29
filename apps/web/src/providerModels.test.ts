import { describe, expect, it } from "vitest";
import type { ProviderKind, ServerProvider } from "@forma/contracts";
import { getDefaultServerModel, resolveSelectableProvider } from "./providerModels";

function provider(input: {
  provider: ProviderKind;
  enabled?: boolean;
  installed?: boolean;
  status?: ServerProvider["status"];
  models?: ServerProvider["models"];
}): ServerProvider {
  return {
    provider: input.provider,
    enabled: input.enabled ?? true,
    installed: input.installed ?? true,
    version: "1.0.0",
    status: input.status ?? "ready",
    auth: { status: "unknown" },
    checkedAt: new Date().toISOString(),
    models: input.models ?? [
      {
        slug: `${input.provider}-model`,
        name: `${input.provider} model`,
        isCustom: false,
        capabilities: null,
      },
    ],
    slashCommands: [],
    skills: [],
  };
}

describe("resolveSelectableProvider", () => {
  it("keeps enabled warning providers selectable when models are available", () => {
    expect(
      resolveSelectableProvider(
        [provider({ provider: "codex" }), provider({ provider: "grok", status: "warning" })],
        "grok",
      ),
    ).toBe("grok");
  });

  it("falls back when the requested provider has no selectable models", () => {
    expect(
      resolveSelectableProvider(
        [provider({ provider: "codex" }), provider({ provider: "grok", models: [] })],
        "grok",
      ),
    ).toBe("codex");
  });
});

describe("getDefaultServerModel", () => {
  it("prefers the configured provider default over model list order", () => {
    expect(
      getDefaultServerModel(
        [
          provider({
            provider: "claudeAgent",
            models: [
              {
                slug: "claude-fable-5",
                name: "Claude Fable 5",
                isCustom: false,
                capabilities: null,
              },
              {
                slug: "claude-sonnet-4-6",
                name: "Claude Sonnet 4.6",
                isCustom: false,
                capabilities: null,
              },
            ],
          }),
        ],
        "claudeAgent",
      ),
    ).toBe("claude-sonnet-4-6");
  });
});
