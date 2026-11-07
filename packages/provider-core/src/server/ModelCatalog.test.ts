import { assert, describe, it } from "@effect/vitest";
import type { ServerProviderModel } from "@t3tools/contracts";

import * as ModelCatalog from "./ModelCatalog.ts";

const model = (overrides: Partial<ServerProviderModel>): ServerProviderModel => ({
  slug: "model-test",
  name: "Model Test",
  isCustom: false,
  capabilities: null,
  ...overrides,
});

const catalogModel = (
  slug: string,
  status: ModelCatalog.ProviderCatalogModel["status"],
): ModelCatalog.ProviderCatalogModel => ({
  slug,
  name: slug,
  status,
  capabilities: null,
  adapter: undefined,
  profileAdapter: undefined,
});

const prefixFamily: ModelCatalog.CatalogMatching = {
  family: (slug) => slug.replace(/^vendor\./, ""),
};

describe("classifyCatalogModels", () => {
  it("flags only known legacy models, clears stale flags, and skips custom models", () => {
    const catalog: ModelCatalog.ProviderCatalog = {
      models: [catalogModel("old-model", "legacy")],
      defaultChatModel: undefined,
    };
    const models = [
      model({ slug: "current-a" }),
      model({ slug: "current-b", isLegacy: true }),
      model({ slug: "old-model" }),
      model({ slug: "my-own-model", isCustom: true, isLegacy: true }),
    ];
    assert.deepStrictEqual(
      ModelCatalog.classifyCatalogModels(models, catalog).map((entry) => [
        entry.slug,
        entry.isLegacy ?? false,
      ]),
      [
        ["current-a", false],
        ["current-b", false],
        ["old-model", true],
        ["my-own-model", true],
      ],
    );
  });

  it("matches qualified slugs through the driver's family without changing their ids", () => {
    const catalog: ModelCatalog.ProviderCatalog = {
      models: [catalogModel("model-old", "legacy")],
      defaultChatModel: undefined,
    };
    assert.deepStrictEqual(
      ModelCatalog.classifyCatalogModels(
        [model({ slug: "vendor.model-test", isLegacy: true }), model({ slug: "vendor.model-old" })],
        catalog,
        prefixFamily,
      ).map((entry) => [entry.slug, entry.isLegacy ?? false]),
      [
        ["vendor.model-test", false],
        ["vendor.model-old", true],
      ],
    );
  });
});

describe("applyCatalogDefault", () => {
  it("moves the default flag and its aliases to the catalog's chat default", () => {
    const catalog: ModelCatalog.ProviderCatalog = {
      models: [catalogModel("model-new", "current")],
      defaultChatModel: "model-new",
    };
    const models = [
      model({ slug: "model-old", isDefault: true, aliases: ["provider-default"] }),
      model({ slug: "model-new" }),
    ];
    assert.deepStrictEqual(ModelCatalog.applyCatalogDefault(models, catalog), [
      model({ slug: "model-old" }),
      model({ slug: "model-new", isDefault: true, aliases: ["provider-default"] }),
    ]);
    assert.deepStrictEqual(
      ModelCatalog.applyCatalogDefault(models.slice(0, 1), catalog),
      models.slice(0, 1),
    );
  });

  it("resolves the catalog default to a qualified discovered model", () => {
    const catalog: ModelCatalog.ProviderCatalog = {
      models: [],
      defaultChatModel: "model-test",
    };
    const models = [
      model({ slug: "vendor.model-old", isDefault: true }),
      model({ slug: "vendor.model-test" }),
    ];
    assert.strictEqual(
      ModelCatalog.applyCatalogDefault(models, catalog, prefixFamily).find(
        (entry) => entry.isDefault,
      )?.slug,
      "vendor.model-test",
    );
  });
});
