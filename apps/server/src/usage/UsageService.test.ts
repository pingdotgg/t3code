import { describe, expect, it } from "@effect/vitest";

import { readGrokHomeOverride } from "./UsageService.ts";

describe("readGrokHomeOverride", () => {
  it.each([undefined, "", "   ", "\t\n"])("treats a blank GROK_HOME as unset (%s)", (value) => {
    expect(readGrokHomeOverride({ GROK_HOME: value })).toBeUndefined();
  });

  it("trims a configured GROK_HOME", () => {
    expect(readGrokHomeOverride({ GROK_HOME: "  ~/.grok-work  " })).toBe("~/.grok-work");
  });
});
