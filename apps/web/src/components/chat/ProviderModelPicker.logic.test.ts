import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  autoLevelsFirst,
  retainedModelWhileProviderLocked,
  withPinnedAutoLevels,
} from "./ProviderModelPicker.logic";

const claude = ProviderDriverKind.make("claudeAgent");
const opus = { slug: "claude-opus-5-5", name: "Claude Opus 5.5", shortName: "Opus 5.5" };
const sonnet = { slug: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", shortName: "Sonnet 5.5" };
const retained = (enabled: boolean, isAvailable: boolean, models = [sonnet, opus]) =>
  retainedModelWhileProviderLocked({ driverKind: claude, enabled, isAvailable, models }, opus.slug);

describe("retainedModelWhileProviderLocked", () => {
  it("shows a hidden saved model while its provider cannot run", () => {
    expect(retained(false, true)).toBe(opus);
    expect(retained(true, false)).toBe(opus);
    expect(retained(false, true, [sonnet])).toEqual({ slug: opus.slug, name: opus.slug });
    expect(retained(true, true)).toBeUndefined();
    expect(retainedModelWhileProviderLocked(null, opus.slug)).toBeUndefined();
  });
});

describe("withPinnedAutoLevels", () => {
  const id = (value: string) => ProviderInstanceId.make(value);
  const autoRows = ["auto-low", "auto-medium", "auto-high"].map((slug) => ({ slug }));
  const entries = [
    { instanceId: id("codex"), driverKind: ProviderDriverKind.make("codex") },
    { instanceId: id("claudeAgent"), driverKind: claude },
    { instanceId: id("claudeAgent_2"), driverKind: claude },
  ];
  const options = new Map([
    [id("codex"), [{ slug: "gpt-6-luna" }]],
    [id("claudeAgent"), [...autoRows, opus]],
    [id("claudeAgent_2"), [...autoRows, opus]],
  ]);
  const saved = [{ provider: id("codex"), model: "gpt-6-luna" }];

  it("pins the first Claude instance's Auto levels above saved favorites", () => {
    expect(withPinnedAutoLevels(saved, entries, options)).toEqual([
      { provider: "claudeAgent", model: "auto-high" },
      { provider: "claudeAgent", model: "auto-medium" },
      { provider: "claudeAgent", model: "auto-low" },
      ...saved,
    ]);
  });

  it("keeps the user's own choice once any Auto level is starred", () => {
    const own = [{ provider: id("claudeAgent_2"), model: "auto-low" }, ...saved];
    expect(withPinnedAutoLevels(own, entries, options)).toBe(own);
  });

  it("changes nothing when no Claude instance lists the Auto levels", () => {
    expect(withPinnedAutoLevels(saved, entries.slice(0, 1), options)).toBe(saved);
  });
});

describe("autoLevelsFirst", () => {
  it("puts Auto High, Medium and Low ahead of other favorites, keeping the rest in order", () => {
    const items = ["gpt-6-luna", "auto-low", "grok-4.7", "auto-high", "auto-medium"].map(
      (slug) => ({
        slug,
      }),
    );
    expect(autoLevelsFirst(items).map((item) => item.slug)).toEqual([
      "auto-high",
      "auto-medium",
      "auto-low",
      "gpt-6-luna",
      "grok-4.7",
    ]);
  });
});
