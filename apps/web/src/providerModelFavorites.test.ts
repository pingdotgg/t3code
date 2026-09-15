import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import {
  matchesProviderModelFavorite,
  toggleProviderModelFavorite,
} from "./providerModelFavorites";

const codex = {
  instanceId: ProviderInstanceId.make("work"),
  driverKind: ProviderDriverKind.make("codex"),
};
const claude = { ...codex, driverKind: ProviderDriverKind.make("claudeAgent") };

describe("driver-aware favorites", () => {
  it("toggles colliding provider/model pairs independently after persistence", () => {
    const first = toggleProviderModelFavorite([], codex, "same");
    expect(matchesProviderModelFavorite(first[0]!, claude)).toBe(false);
    const both = toggleProviderModelFavorite(first, claude, "same");
    const restored: typeof both = JSON.parse(JSON.stringify(both));
    expect(toggleProviderModelFavorite(restored, codex, "same")).toEqual([
      { provider: claude.instanceId, driver: claude.driverKind, model: "same" },
    ]);
    expect(toggleProviderModelFavorite(restored, claude, "same")).toEqual(first);
  });
  it("keeps unambiguous legacy favorites usable but never assigns ambiguous ones to both drivers", () => {
    const legacy = { provider: codex.instanceId, model: "same" };
    expect(matchesProviderModelFavorite(legacy, codex)).toBe(true);
    expect(matchesProviderModelFavorite(legacy, codex, false)).toBe(false);
    expect(matchesProviderModelFavorite(legacy, claude, false)).toBe(false);
    const updated = toggleProviderModelFavorite([legacy], claude, "same", false);
    expect(updated).toHaveLength(2);
    expect(toggleProviderModelFavorite(updated, claude, "same", false)).toEqual([legacy]);
  });
});
