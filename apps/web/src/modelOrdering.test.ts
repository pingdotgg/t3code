import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  pendingFavoriteOrder,
  providerModelKey,
  reorderVisibleFavorites,
  sortProviderModelItems,
} from "./modelOrdering";

const codex = ProviderInstanceId.make("codex");
const claude = ProviderInstanceId.make("claude");
const antigravity = ProviderInstanceId.make("antigravity");

describe("sortProviderModelItems", () => {
  it("orders favorites by explicit favoriteOrder across providers", () => {
    const items = [
      { instanceId: codex, slug: "sol" },
      { instanceId: codex, slug: "astra" },
      { instanceId: claude, slug: "opus" },
      { instanceId: antigravity, slug: "neon" },
    ];

    const sorted = sortProviderModelItems(items, {
      favoriteOrder: [
        providerModelKey(antigravity, "neon"),
        providerModelKey(codex, "astra"),
        providerModelKey(claude, "opus"),
        providerModelKey(codex, "sol"),
      ],
      instanceOrder: [codex, claude, antigravity],
    });

    expect(sorted.map((item) => providerModelKey(item.instanceId, item.slug))).toEqual([
      "antigravity:neon",
      "codex:astra",
      "claude:opus",
      "codex:sol",
    ]);
  });
});

describe("reorderVisibleFavorites", () => {
  it("moves visible favorites while keeping non-visible favorites in their slots", () => {
    const all = [
      { provider: codex, model: "sol" },
      { provider: claude, model: "opus" },
      { provider: antigravity, model: "neon" },
      { provider: claude, model: "fable" },
    ];
    const visible = [providerModelKey(claude, "opus"), providerModelKey(claude, "fable")];

    expect(reorderVisibleFavorites(all, visible, 1, 0)).toEqual([
      { provider: codex, model: "sol" },
      { provider: claude, model: "fable" },
      { provider: antigravity, model: "neon" },
      { provider: claude, model: "opus" },
    ]);
  });

  it("reorders the full favorites list when every favorite is visible", () => {
    const all = [
      { provider: codex, model: "sol" },
      { provider: claude, model: "opus" },
      { provider: antigravity, model: "neon" },
    ];
    const visible = all.map((entry) => providerModelKey(entry.provider, entry.model));

    expect(reorderVisibleFavorites(all, visible, 2, 0)).toEqual([
      { provider: antigravity, model: "neon" },
      { provider: codex, model: "sol" },
      { provider: claude, model: "opus" },
    ]);
  });

  it("preserves repeated non-visible entries in their original slots", () => {
    const hidden = { provider: antigravity, model: "hidden" };
    const all = [
      { provider: codex, model: "sol" },
      hidden,
      hidden,
      { provider: claude, model: "opus" },
    ];
    const visible = [providerModelKey(codex, "sol"), providerModelKey(claude, "opus")];

    expect(reorderVisibleFavorites(all, visible, 1, 0)).toEqual([
      { provider: claude, model: "opus" },
      hidden,
      hidden,
      { provider: codex, model: "sol" },
    ]);
  });
});

describe("pendingFavoriteOrder", () => {
  const sol = { provider: codex, model: "sol" };
  const opus = { provider: claude, model: "opus" };
  const neon = { provider: antigravity, model: "neon" };

  it("keeps the optimistic order until saved favorites match or change membership", () => {
    expect(pendingFavoriteOrder([opus, sol], [sol, opus])).toEqual([opus, sol]);
    expect(pendingFavoriteOrder([opus, sol], [opus, sol])).toBeNull();
    expect(pendingFavoriteOrder([opus, sol], [sol, opus, neon])).toBeNull();
    expect(pendingFavoriteOrder([opus, neon], [sol, opus])).toBeNull();
  });
});
