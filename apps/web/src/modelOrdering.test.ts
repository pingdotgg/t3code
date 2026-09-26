import { describe, expect, it } from "vite-plus/test";
import { ProviderInstanceId } from "@t3tools/contracts";

import {
  partitionLegacyModels,
  providerModelKey,
  sortModelsForProviderInstance,
  sortProviderModelItems,
} from "./modelOrdering";

const CODEX_WORK_ID = ProviderInstanceId.make("codex_work");
const CLAUDE_ID = ProviderInstanceId.make("claudeAgent");

describe("model ordering", () => {
  it("groups favorites first while preserving provider model order inside each group", () => {
    const models = [
      { slug: "gpt-5.5" },
      { slug: "gpt-5.4-mini" },
      { slug: "crest-alpha" },
      { slug: "gpt-5.3-codex" },
    ];

    expect(
      sortModelsForProviderInstance(models, {
        favoriteModels: ["gpt-5.5", "gpt-5.4-mini", "crest-alpha"],
        groupFavorites: true,
        modelOrder: ["gpt-5.4-mini", "gpt-5.5", "crest-alpha", "gpt-5.3-codex"],
      }).map((model) => model.slug),
    ).toEqual(["gpt-5.4-mini", "gpt-5.5", "crest-alpha", "gpt-5.3-codex"]);
  });

  it("sorts the favorites view by provider order, then provider model order", () => {
    const items = [
      { instanceId: CODEX_WORK_ID, slug: "gpt-5.4-mini" },
      { instanceId: CODEX_WORK_ID, slug: "gpt-5.5" },
      { instanceId: CODEX_WORK_ID, slug: "crest-alpha" },
      { instanceId: CLAUDE_ID, slug: "claude-opus-4-6" },
    ];
    const favoriteKeys = [
      providerModelKey(CODEX_WORK_ID, "gpt-5.5"),
      providerModelKey(CLAUDE_ID, "claude-opus-4-6"),
      providerModelKey(CODEX_WORK_ID, "gpt-5.4-mini"),
      providerModelKey(CODEX_WORK_ID, "crest-alpha"),
    ];

    expect(
      sortProviderModelItems(items, {
        favoriteModelKeys: favoriteKeys,
        instanceOrder: [CODEX_WORK_ID, CLAUDE_ID],
      }).map((item) => item.slug),
    ).toEqual(["gpt-5.4-mini", "gpt-5.5", "crest-alpha", "claude-opus-4-6"]);
  });

  describe("partitionLegacyModels", () => {
    const models = [
      { slug: "opus-5" },
      { slug: "sonnet-5" },
      { slug: "opus-4-8", isLegacy: true },
      { slug: "haiku-3", isLegacy: true },
    ];

    it("keeps a favorited legacy model in the main list instead of the legacy group", () => {
      const { current, legacy } = partitionLegacyModels(
        models,
        (model) => model.slug === "opus-4-8",
      );

      expect(current.map((model) => model.slug)).toEqual(["opus-5", "sonnet-5", "opus-4-8"]);
      expect(legacy.map((model) => model.slug)).toEqual(["haiku-3"]);
    });

    it("returns legacy models to the legacy group once unfavorited", () => {
      const { current, legacy } = partitionLegacyModels(models, () => false);

      expect(current.map((model) => model.slug)).toEqual(["opus-5", "sonnet-5"]);
      expect(legacy.map((model) => model.slug)).toEqual(["opus-4-8", "haiku-3"]);
    });

    it("returns empty partitions for an empty list", () => {
      const { current, legacy } = partitionLegacyModels([], () => false);

      expect(current).toEqual([]);
      expect(legacy).toEqual([]);
    });

    it("treats an explicit isLegacy: false as a current model", () => {
      const { current, legacy } = partitionLegacyModels(
        [{ slug: "opus-5", isLegacy: false }],
        () => false,
      );

      expect(current.map((model) => model.slug)).toEqual(["opus-5"]);
      expect(legacy).toEqual([]);
    });

    it("leaves the legacy group empty when every legacy model is favorited", () => {
      const { current, legacy } = partitionLegacyModels(models, (model) => model.isLegacy === true);

      expect(current.map((model) => model.slug)).toEqual([
        "opus-5",
        "sonnet-5",
        "opus-4-8",
        "haiku-3",
      ]);
      expect(legacy).toEqual([]);
    });
  });
});
