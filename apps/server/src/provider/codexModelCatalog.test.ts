import { assert, describe, it } from "@effect/vitest";
import type { ServerProviderModel } from "@t3tools/contracts";
import type * as ModelCatalog from "@t3tools/provider-core/server/ModelCatalog";

import { applyCodexModelCatalog } from "./codexModelCatalog.ts";

const model = (overrides: Partial<ServerProviderModel>): ServerProviderModel => ({
  slug: "gpt-test",
  name: "GPT Test",
  isCustom: false,
  capabilities: null,
  ...overrides,
});

const entry = (
  overrides: Partial<ModelCatalog.ProviderCatalogModel> & { readonly slug: string },
): ModelCatalog.ProviderCatalogModel => ({
  name: overrides.slug,
  status: "current",
  capabilities: null,
  adapter: undefined,
  profileAdapter: undefined,
  ...overrides,
});

const catalog: ModelCatalog.ProviderCatalog = {
  defaultChatModel: undefined,
  models: [
    entry({
      slug: "gpt-next",
      name: "GPT Next",
      badge: "new",
      adapter: { codex: { minVersion: "1.2.0" } },
    }),
    entry({ slug: "gpt-unversioned" }),
    entry({ slug: "gpt-retired", status: "legacy", adapter: { codex: { minVersion: "1.2.0" } } }),
  ],
};

const draft = (version: string | null, models: ReadonlyArray<ServerProviderModel> = []) => ({
  enabled: true,
  installed: true,
  version,
  status: "ready" as const,
  auth: { status: "authenticated" as const },
  checkedAt: "2026-01-01T00:00:00.000Z",
  models,
  slashCommands: [],
  skills: [],
});

describe("applyCodexModelCatalog", () => {
  it("names current models that need a newer Codex and are missing from discovery", () => {
    assert.deepStrictEqual(applyCodexModelCatalog(draft("1.1.9"), catalog).updateRequiredModels, [
      { slug: "gpt-next", name: "GPT Next", badge: "new", minVersion: "1.2.0" },
    ]);
    for (const result of [
      applyCodexModelCatalog(draft("1.2.0"), catalog),
      applyCodexModelCatalog(draft("1.1.9", [model({ slug: "openai.gpt-next" })]), catalog),
      applyCodexModelCatalog(draft(null), catalog),
      applyCodexModelCatalog(draft("1.1.9", [model({ slug: "gpt-next" })]), {
        ...catalog,
        models: [{ ...catalog.models[0]!, slug: "openai.gpt-next" }],
      }),
    ]) {
      assert.isUndefined(result.updateRequiredModels);
    }
  });

  it("classifies qualified Codex families without changing their wire ids", () => {
    const classified = applyCodexModelCatalog(
      draft("1.2.0", [
        model({ slug: "openai.gpt-test", isLegacy: true }),
        model({ slug: "openai.gpt-retired" }),
      ]),
      catalog,
    );
    assert.deepStrictEqual(
      classified.models.map((entry) => [entry.slug, entry.isLegacy ?? false]),
      [
        ["openai.gpt-test", false],
        ["openai.gpt-retired", true],
      ],
    );
  });
});
