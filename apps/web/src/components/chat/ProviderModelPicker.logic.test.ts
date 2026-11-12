import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { retainedModelWhileProviderLocked } from "./ProviderModelPicker.logic";

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
