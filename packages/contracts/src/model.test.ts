import { describe, expect, it } from "vite-plus/test";

import { ProviderDriverKind } from "./providerInstance.ts";
import { MODEL_SLUG_ALIASES_BY_PROVIDER } from "./model.ts";

describe("model slug aliases", () => {
  it("resolves Claudex aliases to the catalog slugs", () => {
    const claudexAliases = MODEL_SLUG_ALIASES_BY_PROVIDER[ProviderDriverKind.make("claudex")];

    expect(claudexAliases?.luna).toBe("claudex-luna");
    expect(claudexAliases?.sol).toBe("claudex-sol");
  });
});
