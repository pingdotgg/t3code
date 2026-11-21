import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  groupUpdateRequiredNotices,
  retainedModelWhileProviderLocked,
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

describe("groupUpdateRequiredNotices", () => {
  it("shows a repeated notice once and names the instances it covers", () => {
    const fable = "Update Claude Code to v2.1.321 or newer to use Claude Fable 5.2.";
    const sol = "Update the Codex CLI to v0.150.0 or newer to use GPT-6.1 Sol.";
    expect(
      groupUpdateRequiredNotices([
        // An enabled instance beside one the project turned off is not badged; the other is.
        { notice: fable, instanceName: "Work", named: false },
        { notice: sol, instanceName: "Codex", named: false },
        { notice: fable, instanceName: "Personal", named: true },
      ]),
    ).toEqual([
      { notice: fable, instanceNames: ["Work", "Personal"] },
      { notice: sol, instanceNames: [] },
    ]);
  });
});
