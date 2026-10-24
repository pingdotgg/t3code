import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { retainedModelWhileProviderLocked } from "./ProviderModelPicker.logic";
import { getTriggerDisplayModelName } from "./providerIconUtils";

const claude = ProviderDriverKind.make("claudeAgent");
const opus = { slug: "claude-opus-5-5", name: "Claude Opus 5.5", shortName: "Opus 5.5" };
const sonnet = { slug: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", shortName: "Sonnet 5.5" };
const label = (enabled: boolean, isAvailable: boolean, models = [sonnet, opus]) => {
  const retained = retainedModelWhileProviderLocked(
    { driverKind: claude, enabled, isAvailable, models },
    opus.slug,
  );
  return retained ? getTriggerDisplayModelName(retained) : undefined;
};

describe("retainedModelWhileProviderLocked", () => {
  it("shows a hidden saved model while its provider cannot run", () => {
    expect(label(false, true)).toBe("Opus 5.5");
    expect(label(true, false)).toBe("Opus 5.5");
    expect(label(false, true, [sonnet])).toBe(opus.slug);
    expect(label(true, true)).toBeUndefined();
    expect(retainedModelWhileProviderLocked(null, opus.slug)).toBeUndefined();
  });
});
