import { describe, expect, it } from "vite-plus/test";
import { ProviderInstanceId } from "@t3tools/contracts";

import {
  moveFavoriteModel,
  providerModelKey,
  replaceInstanceFavorites,
  sortModelsForProviderInstance,
  sortProviderModelItems,
} from "./modelOrdering";

const CODEX_WORK_ID = ProviderInstanceId.make("codex_work");
const CLAUDE_ID = ProviderInstanceId.make("claudeAgent");
const OPENCODE_ID = ProviderInstanceId.make("opencode");

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

  it("sorts the favorites view by the user's favorites order, across providers", () => {
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
      sortProviderModelItems(items, { favoriteOrder: favoriteKeys }).map((item) => item.slug),
    ).toEqual(["gpt-5.5", "claude-opus-4-6", "gpt-5.4-mini", "crest-alpha"]);
  });

  it("moves a favorite without disturbing favorites the view hides", () => {
    const favorites = [
      { provider: CODEX_WORK_ID, model: "gpt-5.5" },
      { provider: OPENCODE_ID, model: "muse" },
      { provider: CODEX_WORK_ID, model: "gpt-5.4-mini" },
      { provider: CLAUDE_ID, model: "claude-opus-4-6" },
    ];
    // OpenCode is disabled, so the favorites view skips its favorite.
    const visibleKeys = [
      providerModelKey(CODEX_WORK_ID, "gpt-5.5"),
      providerModelKey(CODEX_WORK_ID, "gpt-5.4-mini"),
      providerModelKey(CLAUDE_ID, "claude-opus-4-6"),
    ];

    expect(moveFavoriteModel(favorites, visibleKeys, 2, 0)).toEqual([
      { provider: CLAUDE_ID, model: "claude-opus-4-6" },
      { provider: OPENCODE_ID, model: "muse" },
      { provider: CODEX_WORK_ID, model: "gpt-5.5" },
      { provider: CODEX_WORK_ID, model: "gpt-5.4-mini" },
    ]);
    expect(moveFavoriteModel(favorites, visibleKeys, 1, 1)).toBe(favorites);
  });

  it("keeps the favorites order when one provider's favorites change", () => {
    const favorites = [
      { provider: CODEX_WORK_ID, model: "gpt-5.5" },
      { provider: CLAUDE_ID, model: "claude-opus-4-6" },
      { provider: CODEX_WORK_ID, model: "gpt-5.4-mini" },
    ];

    expect(replaceInstanceFavorites(favorites, CODEX_WORK_ID, ["gpt-5.5", "crest-alpha"])).toEqual([
      { provider: CODEX_WORK_ID, model: "gpt-5.5" },
      { provider: CLAUDE_ID, model: "claude-opus-4-6" },
      { provider: CODEX_WORK_ID, model: "crest-alpha" },
    ]);
  });

  it("collapses a duplicated favorite to its first slot when a provider's favorites change", () => {
    const favorites = [
      { provider: CODEX_WORK_ID, model: "gpt-5.5" },
      { provider: CLAUDE_ID, model: "claude-opus-4-6" },
      { provider: CODEX_WORK_ID, model: "gpt-5.5" },
    ];

    expect(replaceInstanceFavorites(favorites, CODEX_WORK_ID, ["gpt-5.5"])).toEqual([
      { provider: CODEX_WORK_ID, model: "gpt-5.5" },
      { provider: CLAUDE_ID, model: "claude-opus-4-6" },
    ]);
  });
});
