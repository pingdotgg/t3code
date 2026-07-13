import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  ClaudexSettings,
  DEFAULT_MODEL_BY_PROVIDER,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";

import {
  makeClaudexContinuationGroupKey,
  normalizeClaudexModelSelection,
  normalizeClaudexProviderSnapshot,
} from "./ClaudexDriver.ts";
import { makeClaudeContinuationGroupKey } from "./ClaudeHome.ts";
import { getClaudeModelCapabilities, resolveClaudeEffort } from "../Layers/ClaudeProvider.ts";
import { buildServerProvider, type ServerProviderDraft } from "../providerSnapshot.ts";

const decodeClaudexSettings = Schema.decodeSync(ClaudexSettings);

const CLAUDE_MODEL_SLUGS = [
  "claude-fable-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-opus-4-5",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
] as const;

const claudeCatalogCapabilities = createModelCapabilities({
  optionDescriptors: [
    {
      id: "effort",
      label: "Reasoning",
      type: "select",
      options: [],
    },
    {
      id: "reasoningEffort",
      label: "Reasoning effort",
      type: "select",
      options: [],
    },
    {
      id: "thinking",
      label: "Thinking",
      type: "boolean",
    },
  ],
});

const fullClaudeCatalog: ReadonlyArray<ServerProviderModel> = CLAUDE_MODEL_SLUGS.map((slug) => ({
  slug,
  name: slug,
  isCustom: false,
  capabilities: claudeCatalogCapabilities,
}));

const claudexDraft: ServerProviderDraft = buildServerProvider({
  driver: ProviderDriverKind.make("claudeAgent"),
  presentation: { displayName: "Claude" },
  enabled: true,
  checkedAt: "2026-01-01T00:00:00.000Z",
  models: [
    ...fullClaudeCatalog,
    {
      slug: "my-custom-claude-model",
      name: "my-custom-claude-model",
      isCustom: true,
      capabilities: claudeCatalogCapabilities,
    },
  ],
  probe: {
    installed: true,
    version: "2.1.169",
    status: "ready",
    auth: { status: "authenticated" },
  },
});

describe("ClaudexDriver", () => {
  it("decodes ClaudexSettings with the Claudex CLI binary default", () => {
    const settings = decodeClaudexSettings({});

    expect(settings.enabled).toBe(true);
    expect(settings.binaryPath).toBe("claudex");
  });

  it("normalizes every provider snapshot to the two Claudex models", () => {
    const normalized = normalizeClaudexProviderSnapshot(claudexDraft);
    const defaultModel = DEFAULT_MODEL_BY_PROVIDER[ProviderDriverKind.make("claudex")];

    expect(normalized.models.map((model) => model.slug)).toEqual(["claudex-luna", "claudex-sol"]);
    expect(normalized.models[0]?.slug).toBe(defaultModel);

    for (const model of normalized.models) {
      const descriptors = model.capabilities?.optionDescriptors ?? [];
      expect(
        descriptors.some(({ id }) => ["effort", "reasoningEffort", "thinking"].includes(id)),
      ).toBe(false);
      expect(descriptors).toEqual([]);
    }
  });

  it("keeps valid Claudex model selections and coerces unknown models to the default", () => {
    const instanceId = ProviderInstanceId.make("claudex");

    expect(normalizeClaudexModelSelection({ instanceId, model: "claudex-sol" })).toEqual({
      instanceId,
      model: "claudex-sol",
    });
    expect(normalizeClaudexModelSelection({ instanceId, model: "claude-fable-5" })).toEqual({
      instanceId,
      model: "claudex-luna",
    });
  });

  it("passes through a missing model selection unchanged", () => {
    expect(normalizeClaudexModelSelection(undefined)).toBeUndefined();
  });

  it("does not expose or resolve effort for Claudex model slugs", () => {
    const capabilities = getClaudeModelCapabilities("claudex-luna");

    expect(capabilities.optionDescriptors ?? []).toEqual([]);
    expect(resolveClaudeEffort(capabilities, "high")).toBeUndefined();
  });
});

it.layer(NodeServices.layer)("ClaudexDriver continuation", (it) => {
  it.effect("uses a continuation group distinct from vanilla Claude for the same HOME", () =>
    Effect.gen(function* () {
      const settings = decodeClaudexSettings({ homePath: "~/.shared-claude-home" });
      const claudexKey = yield* makeClaudexContinuationGroupKey(settings);
      const claudeKey = yield* makeClaudeContinuationGroupKey(settings);

      expect(claudexKey.startsWith("claudex:")).toBe(true);
      expect(claudexKey).not.toBe(claudeKey);
    }),
  );
});
