import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { supportsSelectedResponseFork } from "./threadForking.js";

describe("supportsSelectedResponseFork", () => {
  it("only enables providers with an exact historical fork primitive", () => {
    expect(supportsSelectedResponseFork(ProviderDriverKind.make("codex"))).toBe(true);
    expect(supportsSelectedResponseFork(ProviderDriverKind.make("claudeAgent"))).toBe(true);
    expect(supportsSelectedResponseFork(ProviderDriverKind.make("opencode"))).toBe(true);
    expect(supportsSelectedResponseFork(ProviderDriverKind.make("cursor"))).toBe(false);
    expect(supportsSelectedResponseFork(ProviderDriverKind.make("grok"))).toBe(false);
    expect(supportsSelectedResponseFork(null)).toBe(false);
  });
});
