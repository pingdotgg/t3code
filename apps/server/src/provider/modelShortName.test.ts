import { describe, expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { modelShortName, withModelShortNames } from "./modelShortName.ts";

describe("modelShortName", () => {
  it.each([
    ["Claude Opus 5.5", "claudeAgent", "Opus 5.5"],
    ["GPT-5.4 Mini", "codex", "5.4 Mini"],
    ["GPT-6.1 Sol", "opencode", "6.1 Sol"],
    ["GPT-6.1-Sol", "opencode", "6.1 Sol"],
    ["Grok 4.1 Fast Non-Reasoning", "opencode", undefined],
    ["Grok 4.1 Fast Non-Reasoning", "grok", "4.1 Fast Non-Reasoning"],
    ["GPT-5.3-Codex-Spark", "codex", "5.3 Codex Spark"],
    ["Grok Build", "grok", "Build"],
    ["Grok Build", "cursor", "Build"],
    ["Grok Build", "opencode", undefined],
    ["Gemini 3.1 Pro Preview Custom Tools", "opencode", undefined],
    ["NVIDIA: Nemotron 3 Super", "opencode", "Nemotron 3 Super"],
    ["Google: Gemini 3.1 Pro", "opencode", "Gemini 3.1 Pro"],
    ["Google: 3.1 Pro", "opencode", undefined],
    ["GPT-5.4 Mini", "pi", undefined],
    ["GPT-5.5", "codex", undefined],
    ["GPT-4o", "opencode", undefined],
    ["Gemini 3 (High)", "antigravity", undefined],
    ["Gemini 3.8 Flash (High)", "antigravity", "3.8 Flash (High)"],
    ["gpt-5.5", "opencode", undefined],
  ] as const)("shortens %s on %s to %s", (name, driver, expected) => {
    expect(modelShortName(name, driver)).toBe(expected);
  });
});

describe("withModelShortNames", () => {
  const model = (input: Partial<ServerProviderModel> & { name: string }): ServerProviderModel => ({
    slug: input.name.toLowerCase().replaceAll(" ", "-"),
    isCustom: false,
    capabilities: null,
    ...input,
  });
  const provider = (models: ReadonlyArray<ServerProviderModel>): ServerProvider => ({
    driver: ProviderDriverKind.make("claudeAgent"),
    instanceId: ProviderInstanceId.make("claudeAgent"),
    enabled: true,
    installed: true,
    version: "3.0.0",
    status: "ready",
    checkedAt: "2026-10-23T00:00:00Z",
    auth: { status: "authenticated" },
    models,
    skills: [],
    slashCommands: [],
  });

  it("fills custom models and keeps an explicit shortName", () => {
    const result = withModelShortNames(
      provider([
        model({ name: "Claude Opus 5.5", shortName: "Opus" }),
        model({ name: "Claude Sonnet 6", isCustom: true }),
      ]),
    );
    expect(result.models.map((entry) => entry.shortName)).toEqual(["Opus", "Sonnet 6"]);
  });
});
