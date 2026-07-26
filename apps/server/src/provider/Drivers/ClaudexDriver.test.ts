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
  normalizeClaudexProviderEffort,
  normalizeClaudexProviderSnapshot,
} from "./ClaudexDriver.ts";
import {
  CLAUDEX_MODELS,
  getClaudexModelCapabilities,
  normalizeClaudexEffort,
} from "../claudexModels.ts";
import { makeClaudeContinuationGroupKey } from "./ClaudeHome.ts";
import {
  getClaudeModelCapabilities,
  normalizeClaudeCliEffort,
  resolveClaudeEffort,
} from "../Layers/ClaudeProvider.ts";
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
  driver: ProviderDriverKind.make("claudex"),
  presentation: { displayName: "Claude Code" },
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

  it("adds Claudex models to the Claude Code provider catalog", () => {
    const duplicateLuna = {
      slug: "claudex-luna",
      name: "Duplicate Luna",
      isCustom: true,
      capabilities: claudeCatalogCapabilities,
    } satisfies ServerProviderModel;
    const normalized = normalizeClaudexProviderSnapshot({
      ...claudexDraft,
      models: [...claudexDraft.models, duplicateLuna],
    });
    const defaultModel = DEFAULT_MODEL_BY_PROVIDER[ProviderDriverKind.make("claudex")];

    expect(normalized.models.map((model) => model.slug)).toEqual([
      "claudex-luna",
      "claudex-sol",
      ...CLAUDE_MODEL_SLUGS,
      "my-custom-claude-model",
    ]);
    expect(normalized.models[0]?.slug).toBe(defaultModel);
    expect(normalized.models.filter((model) => model.slug === "claudex-luna")).toHaveLength(1);
    expect(normalized.models.find((model) => model.slug === "claude-fable-5")?.capabilities).toBe(
      claudeCatalogCapabilities,
    );
    expect(
      normalized.models.find((model) => model.slug === "my-custom-claude-model"),
    ).toMatchObject({
      isCustom: true,
      capabilities: claudeCatalogCapabilities,
    });

    for (const model of normalized.models.slice(0, 2)) {
      const descriptors = model.capabilities?.optionDescriptors ?? [];
      expect(descriptors.map(({ id }) => id)).toEqual(["effort"]);
      expect(descriptors[0]).toMatchObject({
        id: "effort",
        label: "Reasoning",
        type: "select",
        options: [
          { id: "low", label: "Low" },
          { id: "medium", label: "Medium" },
          { id: "high", label: "High" },
          { id: "xhigh", label: "Extra High" },
          { id: "max", label: "Max" },
          { id: "ultracode", label: "Ultracode" },
        ],
      });
      expect(descriptors[0]).not.toHaveProperty("promptInjectedValues");
      expect(descriptors[0]?.type === "select" ? descriptors[0].currentValue : undefined).toBe(
        model.slug === "claudex-luna" ? "max" : "high",
      );
    }
  });

  it("keeps every non-empty Claude Code model selection and defaults blank models", () => {
    const instanceId = ProviderInstanceId.make("claudex");

    expect(normalizeClaudexModelSelection({ instanceId, model: "claudex-sol" })).toEqual({
      instanceId,
      model: "claudex-sol",
    });
    expect(
      normalizeClaudexModelSelection({
        instanceId,
        model: "claude-fable-5",
        options: [{ id: "effort", value: "xhigh" }],
      }),
    ).toEqual({
      instanceId,
      model: "claude-fable-5",
      options: [{ id: "effort", value: "xhigh" }],
    });
    expect(
      normalizeClaudexModelSelection({
        instanceId,
        model: "my-custom-claude-model",
      }),
    ).toEqual({ instanceId, model: "my-custom-claude-model" });
    expect(normalizeClaudexModelSelection({ instanceId, model: "  " })).toEqual({
      instanceId,
      model: "claudex-luna",
    });
  });

  it("passes through a missing model selection unchanged", () => {
    expect(normalizeClaudexModelSelection(undefined)).toBeUndefined();
  });

  it("exposes Claudex effort capabilities and defaults", () => {
    expect(CLAUDEX_MODELS).toHaveLength(2);
    expect(getClaudexModelCapabilities("claudex-sol")).toBe(CLAUDEX_MODELS[1]?.capabilities);
    expect(getClaudexModelCapabilities("unknown")).toBeUndefined();
    expect(resolveClaudeEffort(getClaudexModelCapabilities("claudex-luna")!, "xhigh")).toBe(
      "xhigh",
    );
    expect(resolveClaudeEffort(getClaudexModelCapabilities("claudex-luna")!, undefined)).toBe(
      "max",
    );
    expect(resolveClaudeEffort(getClaudexModelCapabilities("claudex-sol")!, undefined)).toBe(
      "high",
    );
    expect(resolveClaudeEffort(getClaudexModelCapabilities("claudex-sol")!, "ultracode")).toBe(
      "ultracode",
    );
  });

  it("uses model-family capabilities and effort normalization", () => {
    for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
      expect(normalizeClaudexEffort(effort)).toBe(effort);
    }
    expect(normalizeClaudexEffort("ultracode")).toBe("xhigh");
    for (const effort of [undefined, "ultrathink", "garbage"]) {
      expect(normalizeClaudexEffort(effort)).toBeUndefined();
    }

    expect(normalizeClaudexProviderEffort("ultracode", "claudex-luna")).toBe("xhigh");
    expect(normalizeClaudexProviderEffort("ultrathink", "claudex-luna")).toBeUndefined();
    expect(normalizeClaudexProviderEffort("ultracode", "claude-opus-5")).toBe("xhigh");
    expect(normalizeClaudexProviderEffort("ultrathink", "claude-opus-5")).toBeUndefined();
    expect(normalizeClaudexProviderEffort("xhigh", "claude-opus-4-6")).toBe("max");

    expect(normalizeClaudeCliEffort("xhigh", "claudex-luna")).toBe("xhigh");
    expect(getClaudeModelCapabilities("claudex-luna")).toBe(
      getClaudexModelCapabilities("claudex-luna"),
    );
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
