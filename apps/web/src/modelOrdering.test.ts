import { describe, expect, it } from "vite-plus/test";
import { ProviderInstanceId } from "@t3tools/contracts";

import { providerModelKey, sortProviderModelItems } from "./modelOrdering";

const CODEX_WORK_ID = ProviderInstanceId.make("codex_work");
const CLAUDE_ID = ProviderInstanceId.make("claudeAgent");

describe("model ordering", () => {
  it("renders favorites in saved order across providers, ignoring unavailable favorites", () => {
    const items = Object.freeze([
      { instanceId: CODEX_WORK_ID, slug: "direct-max" },
      { instanceId: CODEX_WORK_ID, slug: "pooled-model" },
      { instanceId: CLAUDE_ID, slug: "pooled-model" },
    ]);
    const favoriteModelOrder = Object.freeze([
      providerModelKey(CLAUDE_ID, "pooled-model"),
      providerModelKey(CLAUDE_ID, "unavailable-model"),
      providerModelKey(CODEX_WORK_ID, "pooled-model"),
      providerModelKey(CODEX_WORK_ID, "direct-max"),
    ]);

    expect(
      sortProviderModelItems(items, {
        favoriteModelOrder,
      }),
    ).toEqual([items[2], items[1], items[0]]);
    expect(items.map((item) => item.slug)).toEqual(["direct-max", "pooled-model", "pooled-model"]);
  });

  it("groups favorites in provider tabs without changing their catalog order", () => {
    const items = [
      { instanceId: CODEX_WORK_ID, slug: "first" },
      { instanceId: CODEX_WORK_ID, slug: "second" },
      { instanceId: CODEX_WORK_ID, slug: "third" },
    ];

    expect(
      sortProviderModelItems(items, {
        favoriteModelKeys: [
          providerModelKey(CODEX_WORK_ID, "third"),
          providerModelKey(CODEX_WORK_ID, "first"),
        ],
        groupFavorites: true,
      }),
    ).toEqual([items[0], items[2], items[1]]);
  });
});
