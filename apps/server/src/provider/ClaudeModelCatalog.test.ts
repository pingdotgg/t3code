import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";

import { hasValidClaudeManifestAdapters } from "./ClaudeModelManifest.ts";
import type { ModelManifestData } from "./ModelManifest.ts";
import {
  formatClaudeVersionUpgradeMessage,
  getClaudeCatalogModelCapabilities,
  isClaudeCatalogCustomEffortProfile,
  normalizeClaudeCatalogEffort,
  resolveClaudeCatalogApiModelId,
  resolveClaudeCatalogEffort,
  resolveClaudeModelCatalog,
  resolveClaudeModelsForVersion,
  resolveClaudeModelSlug,
  scopeClaudeModelCatalog,
} from "./ClaudeModelCatalog.ts";

/**
 * Test policy: adding or changing a real Claude model in model-manifest.json
 * must not add or update tests here. These synthetic fixtures cover resolver
 * behavior once. Add a test only when Claude adapter semantics change, such
 * as introducing a new compatibility rule or dispatch mapping type.
 */

const manifest = (): ModelManifestData => ({
  version: 1,
  currentModels: {},
  providers: {
    claudeAgent: {
      profiles: {
        synthetic: {
          capabilities: {
            optionDescriptors: [
              {
                id: "effort",
                label: "Reasoning",
                type: "select",
                options: [{ id: "extreme", label: "Extreme", isDefault: true }],
              },
              {
                id: "contextWindow",
                label: "Context Window",
                type: "select",
                options: [{ id: "large", label: "Large", isDefault: true }],
              },
            ],
          },
          adapter: {
            claudeCode: {
              effortMap: { extreme: "high" },
              modelSuffixes: { contextWindow: { large: "[large]" } },
            },
          },
        },
      },
      models: [
        {
          slug: "claude-synthetic-next",
          name: "Claude Synthetic Next",
          aliases: ["synthetic"],
          status: "current",
          profile: "synthetic",
          adapter: { claudeCode: { minVersion: "3.2.0" } },
        },
      ],
    },
  },
});

describe("Claude model catalog", () => {
  it("filters models at runtime-version boundaries and derives the upgrade message", () => {
    const catalog = resolveClaudeModelCatalog(manifest());
    assert.deepStrictEqual(resolveClaudeModelsForVersion(catalog, "3.1.9"), []);
    assert.deepStrictEqual(
      resolveClaudeModelsForVersion(catalog, "3.2.0").map((model) => model.slug),
      ["claude-synthetic-next"],
    );
    assert.strictEqual(
      formatClaudeVersionUpgradeMessage(catalog, "3.1.9"),
      "Claude Code v3.1.9 is too old for Claude Synthetic Next. Upgrade to v3.2.0 or newer to access it.",
    );
  });

  it("resolves aliases and declarative adapter mappings", () => {
    const base = manifest();
    const input: ModelManifestData = {
      ...base,
      providers: {
        ...base.providers,
        claudeAgent: {
          ...base.providers!.claudeAgent!,
          models: [
            {
              slug: "claude-synthetic-collision",
              name: "Claude Synthetic Collision",
              aliases: ["claude-synthetic-next"],
              status: "current",
            },
            ...base.providers!.claudeAgent!.models,
          ],
        },
      },
    };
    const catalog = resolveClaudeModelCatalog(input);
    assert.strictEqual(resolveClaudeModelSlug(catalog, "synthetic"), "claude-synthetic-next");
    assert.strictEqual(
      resolveClaudeModelSlug(catalog, "claude-synthetic-next"),
      "claude-synthetic-next",
    );
    assert.strictEqual(normalizeClaudeCatalogEffort(catalog, "extreme", "synthetic"), "high");
    assert.strictEqual(
      resolveClaudeCatalogApiModelId(catalog, {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "synthetic",
      }),
      "claude-synthetic-next[large]",
    );
  });

  it("scopes custom aliases and attaches configured effort profiles", () => {
    const catalog = scopeClaudeModelCatalog(
      resolveClaudeModelCatalog(manifest()),
      ["synthetic", "custom-model", "custom-model"],
      {
        "custom-model": {
          capabilities: { reasoning: { levels: ["low", "xhigh"] } },
        },
      },
    );

    assert.strictEqual(resolveClaudeModelSlug(catalog, "synthetic"), "synthetic");
    assert.isTrue(isClaudeCatalogCustomEffortProfile(catalog, "custom-model"));
    assert.deepStrictEqual(
      getClaudeCatalogModelCapabilities(catalog, "custom-model").optionDescriptors?.[0],
      {
        id: "effort",
        label: "Reasoning",
        type: "select",
        options: [
          { id: "default", label: "Default", isDefault: true },
          { id: "low", label: "Low" },
          { id: "xhigh", label: "Extra High" },
        ],
        currentValue: "default",
      },
    );
    assert.strictEqual(resolveClaudeCatalogEffort(catalog, "custom-model", undefined), "default");
    assert.strictEqual(normalizeClaudeCatalogEffort(catalog, "xhigh", "custom-model"), "xhigh");
    assert.deepStrictEqual(
      catalog.models.filter((entry) => entry.model.slug === "custom-model").length,
      1,
    );
  });

  it("keeps built-in catalog capabilities when a custom profile uses the same slug", () => {
    const catalog = scopeClaudeModelCatalog(
      resolveClaudeModelCatalog(manifest()),
      ["claude-synthetic-next"],
      {
        "claude-synthetic-next": {
          capabilities: { reasoning: { levels: ["low"] } },
        },
      },
    );

    assert.isFalse(isClaudeCatalogCustomEffortProfile(catalog, "claude-synthetic-next"));
    assert.strictEqual(
      resolveClaudeCatalogEffort(catalog, "claude-synthetic-next", undefined),
      "extreme",
    );
  });

  it("does not treat prototype keys as configured profiles", () => {
    const catalog = scopeClaudeModelCatalog(resolveClaudeModelCatalog(manifest()), ["toString"], {
      "other-model": {
        capabilities: { reasoning: { levels: ["high"] } },
      },
    });

    assert.isFalse(isClaudeCatalogCustomEffortProfile(catalog, "toString"));
    assert.deepStrictEqual(
      getClaudeCatalogModelCapabilities(catalog, "toString").optionDescriptors,
      [],
    );
  });

  it("rejects malformed adapter mappings", () => {
    const base = manifest();
    const malformed: ModelManifestData = {
      ...base,
      providers: {
        ...base.providers,
        claudeAgent: {
          ...base.providers!.claudeAgent!,
          profiles: {
            ...base.providers!.claudeAgent!.profiles,
            synthetic: {
              ...base.providers!.claudeAgent!.profiles.synthetic!,
              adapter: { claudeCode: { effortMap: { extreme: 123 } } },
            },
          },
        },
      },
    };
    assert.isFalse(hasValidClaudeManifestAdapters(malformed));
  });
});
