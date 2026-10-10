import * as NodeServices from "@effect/platform-node/NodeServices";
import { CodexSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { assert, it } from "@effect/vitest";

import {
  applyPreferredCodexDefaultModel,
  checkCodexProviderStatus,
  mapCodexModelCapabilities,
} from "./CodexProvider.ts";

const decodeCodexSettingsForPermission = Schema.decodeEffect(CodexSettings);

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
      {
        id: "ultrafast",
        name: "Ultrafast",
        description: "The fastest available responses for latency-sensitive work.",
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
        {
          id: "ultrafast",
          label: "Ultrafast",
          description: "Even faster, more expensive",
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

it("ranks qualified Codex models while preserving their wire ids", () => {
  const models = applyPreferredCodexDefaultModel([
    {
      slug: "openai.gpt-5.6-luna",
      name: "Luna",
      isCustom: false,
      isDefault: true,
      capabilities: null,
    },
    { slug: "openai.gpt-5.6-sol", name: "Sol", isCustom: false, capabilities: null },
  ]);
  assert.deepStrictEqual(
    models.filter((model) => model.isDefault).map((model) => model.slug),
    ["openai.gpt-5.6-sol"],
  );
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

it.effect("publishes native permission and denial from a successful account probe", () =>
  Effect.gen(function* () {
    const settings = yield* decodeCodexSettingsForPermission({});
    const status = yield* checkCodexProviderStatus(
      settings,
      () =>
        Effect.succeed({
          account: {
            account: { type: "chatgpt", email: "fixture@example.invalid", planType: "pro" },
            requiresOpenaiAuth: false,
          },
          rateLimits: {
            snapshot: {
              primary: { usedPercent: 1 },
              rateLimitReachedType: "workspace_member_usage_limit_reached",
            },
            ordinaryUsageAllowed: false,
            resetCredits: undefined,
          },
          version: "fixture",
          models: [],
          skills: [],
        }),
      {},
    );
    assert.strictEqual(status.usageLimits?.ordinaryUsageAllowed, false);
    assert.strictEqual(status.usageLimits?.ordinaryUsageCheckedAt, status.checkedAt);
    assert.strictEqual(
      status.usageLimits?.rateLimitReachedType,
      "workspace_member_usage_limit_reached",
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("publishes the main spend-control denial despite ordinary permission and low usage", () =>
  Effect.gen(function* () {
    const settings = yield* decodeCodexSettingsForPermission({});
    const probe = {
      account: {
        account: {
          type: "chatgpt" as const,
          email: "fixture@example.invalid",
          planType: "pro" as const,
        },
        requiresOpenaiAuth: false,
      },
      rateLimits: {
        snapshot: {
          limitId: "codex",
          spendControlReached: true,
          rateLimitReachedType: null,
          primary: { usedPercent: 1 },
        },
        ordinaryUsageAllowed: true,
        resetCredits: undefined,
      },
      version: "fixture",
      models: [],
      skills: [],
    };
    const status = yield* checkCodexProviderStatus(settings, () => Effect.succeed(probe), {});
    assert.deepStrictEqual(
      status.usageLimits && {
        ...status.usageLimits,
        windows: [],
      },
      {
        checkedAt: status.checkedAt,
        windows: [],
        spendControlReached: true,
        ordinaryUsageAllowed: true,
        ordinaryUsageCheckedAt: status.checkedAt,
        rateLimitReachedType: null,
      },
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
