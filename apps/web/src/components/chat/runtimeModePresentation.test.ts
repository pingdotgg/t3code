import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { getRuntimeModeOptions, normalizeRuntimeModeForProvider } from "./runtimeModePresentation";

describe("runtimeModePresentation", () => {
  it("keeps medium access available only for Droid", () => {
    expect(getRuntimeModeOptions(ProviderDriverKind.make("droid"))).toContain("medium-access");
    expect(getRuntimeModeOptions(ProviderDriverKind.make("codex"))).not.toContain("medium-access");
  });

  it("normalizes Droid-only medium access when switching to another provider", () => {
    expect(normalizeRuntimeModeForProvider(ProviderDriverKind.make("codex"), "medium-access")).toBe(
      "auto-accept-edits",
    );
    expect(normalizeRuntimeModeForProvider(ProviderDriverKind.make("droid"), "medium-access")).toBe(
      "medium-access",
    );
    expect(normalizeRuntimeModeForProvider(ProviderDriverKind.make("codex"), "full-access")).toBe(
      "full-access",
    );
  });
});
