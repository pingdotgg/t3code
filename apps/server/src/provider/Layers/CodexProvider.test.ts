import { assert, it } from "@effect/vitest";

import {
  applyPreferredCodexDefaultModel,
  isLegacyCodexModel,
  mapCodexModelCapabilities,
  parseCodexSkillsListResponse,
} from "./CodexProvider.ts";

it("keeps repo skills tagged per workspace and user skills global", () => {
  const skill = (name: string, description: string, path: string, scope: "repo" | "user") => ({
    name,
    description,
    path,
    scope,
    enabled: true,
  });
  const skills = parseCodexSkillsListResponse(
    {
      data: [
        {
          cwd: "/workspace/a",
          errors: [],
          skills: [
            skill("user-tool", "User skill", "/home/.codex/skills/user-tool/SKILL.md", "user"),
            skill("a-only", "A only", "/workspace/a/.agents/skills/a-only/SKILL.md", "repo"),
            skill("shared", "From A", "/workspace/a/.agents/skills/shared/SKILL.md", "repo"),
          ],
        },
        {
          cwd: "/workspace/b",
          errors: [],
          skills: [
            skill("user-tool", "User skill", "/home/.codex/skills/user-tool/SKILL.md", "user"),
            skill("b-only", "B only", "/workspace/b/.agents/skills/b-only/SKILL.md", "repo"),
            skill("shared", "From B", "/workspace/b/.agents/skills/shared/SKILL.md", "repo"),
          ],
        },
      ],
    },
    ["/workspace/a", "/workspace/b"],
  );

  assert.deepStrictEqual(
    skills.map((entry) => [entry.name, entry.sourceCwd, entry.description]),
    [
      ["a-only", "/workspace/a", "A only"],
      ["b-only", "/workspace/b", "B only"],
      ["shared", "/workspace/a", "From A"],
      ["shared", "/workspace/b", "From B"],
      ["user-tool", undefined, "User skill"],
    ],
  );
});

it("matches and stamps repo skills when Codex cwd form differs from the request", () => {
  const skill = (name: string, description: string, path: string) => ({
    name,
    description,
    path,
    scope: "repo" as const,
    enabled: true,
  });
  const skills = parseCodexSkillsListResponse(
    {
      data: [
        {
          // Trailing slash / non-resolved form on the wire.
          cwd: "/workspace/a/",
          errors: [],
          skills: [skill("a-only", "A only", "/workspace/a/.agents/skills/a-only/SKILL.md")],
        },
      ],
    },
    ["/workspace//a/./"],
  );

  assert.deepStrictEqual(
    skills.map((entry) => [entry.name, entry.sourceCwd]),
    [["a-only", "/workspace/a"]],
  );
});

it("keeps current Codex models out of legacy models", () => {
  assert.deepStrictEqual(
    [
      "gpt-5.6-luna",
      "gpt-5.6-terra",
      "gpt-5.6-sol",
      "gpt-daybreak-blue-latest",
      "gpt-daybreak-red-latest",
      "gpt-5.4",
    ].map((model) => [model, isLegacyCodexModel(model)]),
    [
      ["gpt-5.6-luna", false],
      ["gpt-5.6-terra", false],
      ["gpt-5.6-sol", false],
      ["gpt-daybreak-blue-latest", false],
      ["gpt-daybreak-red-latest", false],
      ["gpt-5.4", true],
    ],
  );
});

it("maps current Codex model capability fields", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: [],
    defaultReasoningEffort: "super-high",
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-test",
    isDefault: true,
    model: "gpt-test",
    defaultServiceTier: "flex",
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "Lower latency responses.",
      },
      {
        id: "flex",
        name: "Flex",
        description: "Lower-cost asynchronous routing.",
      },
    ],
    supportedReasoningEfforts: [
      {
        description: "Maximum reasoning",
        reasoningEffort: "super-high",
      },
    ],
  });

  assert.deepStrictEqual(capabilities.optionDescriptors, [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [{ id: "super-high", label: "super-high", isDefault: true }],
      currentValue: "super-high",
    },
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard" },
        {
          id: "priority",
          label: "Fast",
          description: "Lower latency responses.",
        },
        {
          id: "flex",
          label: "Flex",
          description: "Lower-cost asynchronous routing.",
          isDefault: true,
        },
      ],
      currentValue: "flex",
    },
  ]);
});

it("uses standard routing when the catalog has no default service tier", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: ["fast"],
    defaultReasoningEffort: "medium",
    defaultServiceTier: null,
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-test",
    isDefault: true,
    model: "gpt-test",
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "1.5x speed, increased usage",
      },
    ],
    supportedReasoningEfforts: [],
  });

  assert.deepStrictEqual(capabilities.optionDescriptors, [
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard", isDefault: true },
        {
          id: "priority",
          label: "Fast",
          description: "1.5x speed, increased usage",
        },
      ],
      currentValue: "default",
    },
  ]);
});

it("marks the most preferred available model as default", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-terra", name: "GPT-5.6-Terra", isCustom: false, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(
    models.map((model) => ({ slug: model.slug, isDefault: model.isDefault })),
    [
      { slug: "gpt-5.6-terra", isDefault: true },
      { slug: "gpt-5.4", isDefault: undefined },
    ],
  );
});

it("prefers sol over terra when both are available", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-terra", name: "GPT-5.6-Terra", isCustom: false, capabilities: null },
    { slug: "gpt-5.6-sol", name: "GPT-5.6-Sol", isCustom: false, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.6-sol");
});

it("keeps Codex's own default when no preferred model is available", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.5", name: "GPT-5.5", isCustom: false, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.4");
});

it("ignores custom models that shadow a preferred slug", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-sol", name: "gpt-5.6-sol", isCustom: true, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.4");
});
