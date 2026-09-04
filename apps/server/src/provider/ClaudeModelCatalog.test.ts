import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";

import { hasValidClaudeManifestAdapters } from "./ClaudeModelManifest.ts";
import type { ModelManifestData } from "./ModelManifest.ts";
import {
  formatClaudeVersionUpgradeMessage,
  getClaudeCatalogModelCapabilities,
  normalizeClaudeCatalogEffort,
  resolveClaudeCatalogApiModelId,
  resolveClaudeCatalogContextWindow,
  resolveClaudeCatalogContextWindowTokens,
  resolveClaudeCatalogEffort,
  resolveClaudeCatalogTemplate,
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
              contextWindowTokens: { large: 400_000 },
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

describe("Claude gateway-prefixed models", () => {
  const catalog = () => resolveClaudeModelCatalog(manifest());
  const selection = (model: string) => ({
    instanceId: ProviderInstanceId.make("claudeAgent"),
    model,
  });

  it("resolves the template a prefixed slug is modelled on, by slug or alias", () => {
    const resolved = catalog();
    assert.strictEqual(
      resolveClaudeCatalogTemplate(resolved, "gateway/claude-synthetic-next")?.model.slug,
      "claude-synthetic-next",
    );
    assert.strictEqual(
      resolveClaudeCatalogTemplate(resolved, "gateway/SYNTHETIC")?.model.slug,
      "claude-synthetic-next",
    );
  });

  it("only treats a single leading segment as a gateway prefix", () => {
    const resolved = catalog();
    assert.isUndefined(resolveClaudeCatalogTemplate(resolved, "claude-synthetic-next"));
    assert.isUndefined(
      resolveClaudeCatalogTemplate(resolved, "gateway/team/claude-synthetic-next"),
    );
    assert.isUndefined(resolveClaudeCatalogTemplate(resolved, "/claude-synthetic-next"));
    assert.isUndefined(resolveClaudeCatalogTemplate(resolved, "gateway/"));
  });

  it("borrows template capabilities and runtime mappings", () => {
    const resolved = catalog();
    const slug = "gateway/claude-synthetic-next";
    assert.deepStrictEqual(
      getClaudeCatalogModelCapabilities(resolved, slug).optionDescriptors?.map(
        (descriptor) => descriptor.id,
      ),
      ["effort", "contextWindow"],
    );
    assert.strictEqual(resolveClaudeCatalogEffort(resolved, slug, "extreme"), "extreme");
    assert.strictEqual(normalizeClaudeCatalogEffort(resolved, "extreme", slug), "high");
    assert.strictEqual(resolveClaudeCatalogContextWindow(resolved, selection(slug)), "large");
    assert.strictEqual(resolveClaudeCatalogContextWindowTokens(resolved, selection(slug)), 400_000);
  });

  it("keeps the prefixed slug on the wire and only appends the template suffix", () => {
    const resolved = catalog();
    assert.strictEqual(
      resolveClaudeModelSlug(resolved, "gateway/claude-synthetic-next"),
      "gateway/claude-synthetic-next",
    );
    assert.strictEqual(resolveClaudeModelSlug(resolved, "gateway/synthetic"), "gateway/synthetic");
    assert.strictEqual(
      resolveClaudeCatalogApiModelId(resolved, selection("gateway/claude-synthetic-next")),
      "gateway/claude-synthetic-next[large]",
    );
    assert.strictEqual(
      resolveClaudeCatalogApiModelId(resolved, selection("gateway/synthetic")),
      "gateway/synthetic[large]",
    );
  });

  it("leaves slugs without a matching template opaque", () => {
    const resolved = catalog();
    assert.deepStrictEqual(
      getClaudeCatalogModelCapabilities(resolved, "gateway/claude-unknown").optionDescriptors,
      [],
    );
    assert.isUndefined(resolveClaudeCatalogEffort(resolved, "gateway/claude-unknown", "extreme"));
    assert.strictEqual(
      resolveClaudeCatalogApiModelId(resolved, selection("gateway/claude-unknown")),
      "gateway/claude-unknown",
    );
    assert.isUndefined(
      resolveClaudeCatalogContextWindowTokens(resolved, selection("gateway/claude-unknown")),
    );
  });

  it("stays resolvable when a custom model shadows an alias", () => {
    const scoped = scopeClaudeModelCatalog(catalog(), [
      "synthetic",
      "gateway/claude-synthetic-next",
    ]);
    assert.deepStrictEqual(
      getClaudeCatalogModelCapabilities(scoped, "synthetic").optionDescriptors,
      [],
      "a custom slug shadows the alias it collides with",
    );
    assert.isUndefined(
      resolveClaudeCatalogTemplate(scoped, "gateway/synthetic"),
      "a prefixed slug built on a shadowed alias stays opaque",
    );
    assert.strictEqual(
      resolveClaudeCatalogTemplate(scoped, "gateway/claude-synthetic-next")?.model.slug,
      "claude-synthetic-next",
      "a prefixed slug built on a canonical slug keeps its template",
    );
    assert.strictEqual(
      resolveClaudeCatalogApiModelId(scoped, selection("gateway/claude-synthetic-next")),
      "gateway/claude-synthetic-next[large]",
    );
  });
});
