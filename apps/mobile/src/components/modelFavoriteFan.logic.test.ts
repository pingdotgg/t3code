import { describe, expect, it } from "vite-plus/test";
import { ProviderInstanceId } from "@t3tools/contracts";
import type { ModelOption } from "../lib/modelOptions";
import {
  FAVORITE_FAN_TARGET_SIZE,
  hitFavoriteFan,
  layoutFavoriteFan,
  resolveFanModels,
} from "./modelFavoriteFan";

function model(provider: string, name: string): ModelOption {
  return {
    key: `${provider}:${name}`,
    label: name,
    subtitle: "",
    providerKey: provider,
    providerLabel: provider,
    providerDriver: provider,
    isDefault: false,
    isLegacy: false,
    capabilities: null,
    selection: { instanceId: ProviderInstanceId.make(provider), model: name },
  };
}

describe("favorite model fan", () => {
  it("keeps favorites from different provider instances in saved order", () => {
    const claude = model("claudeAgent", "shared");
    const codex = model("codex", "shared");
    const hidden = { ...model("codex", "hidden"), isHidden: true };
    const unavailable = { ...model("codex", "unavailable"), isUnavailable: true };
    const removed = model("codex", "removed");
    const favorites = [hidden, claude, removed, unavailable, claude, codex].map(
      ({ selection }) => ({ provider: selection.instanceId, model: selection.model }),
    );

    expect(resolveFanModels(favorites, [codex, claude, hidden, unavailable])).toEqual([
      claude,
      codex,
    ]);
  });

  it("keeps five distinct targets above the finger and inside either edge", () => {
    const bounds = { left: 5, right: 325, top: 40 };
    const halfTarget = FAVORITE_FAN_TARGET_SIZE / 2;
    for (const x of [35, 295]) {
      const origin = { x, y: 690 };
      const { targets } = layoutFavoriteFan(origin, bounds, 5);
      for (const [index, target] of targets.entries()) {
        expect(target.x - halfTarget).toBeGreaterThan(bounds.left);
        expect(target.x + halfTarget).toBeLessThan(bounds.right);
        expect(target.y + halfTarget).toBeLessThan(origin.y);
        expect(hitFavoriteFan(targets, origin, target.x, target.y)).toBe(index);
      }
    }
  });

  it("keeps top-constrained targets selectable", () => {
    const origin = { x: 164, y: 100 };
    const { targets } = layoutFavoriteFan(origin, { left: 0, right: 328, top: 0 }, 1);
    const target = targets[0]!;
    expect(hitFavoriteFan(targets, origin, target.x, target.y)).toBe(0);
    expect(hitFavoriteFan(targets, origin, origin.x, origin.y)).toBe(-1);
  });

  it("cancels release over the control or far outside the fan", () => {
    const origin = { x: 164, y: 490 };
    const { targets } = layoutFavoriteFan(origin, { left: 0, right: 328, top: 0 }, 3);
    expect(hitFavoriteFan(targets, origin, origin.x, origin.y)).toBe(-1);
    expect(hitFavoriteFan(targets, origin, origin.x, 290)).toBe(-1);
  });
});
