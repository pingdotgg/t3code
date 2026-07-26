import { describe, expect, it } from "vite-plus/test";

import { ProviderDriverKind } from "./providerInstance.ts";
import { MODEL_SLUG_ALIASES_BY_PROVIDER } from "./model.ts";

describe("model slug aliases", () => {
  it("resolves Claude aliases to the catalog slugs", () => {
    const claudeAliases = MODEL_SLUG_ALIASES_BY_PROVIDER[ProviderDriverKind.make("claudeAgent")];

    expect(claudeAliases?.fable).toBe("claude-fable-5");
    expect(claudeAliases?.["fable-5"]).toBe("claude-fable-5");
    expect(claudeAliases?.opus).toBe("claude-opus-5");
    expect(claudeAliases?.["opus-5"]).toBe("claude-opus-5");
    expect(claudeAliases?.["claude-opus-5"]).toBe("claude-opus-5");
  });
});
