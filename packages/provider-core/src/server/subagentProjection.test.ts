import { describe, expect, it } from "vite-plus/test";

import { subagentThreadTitle } from "./subagentProjection.ts";

describe("subagentThreadTitle", () => {
  it("clips a long prompt without splitting a surrogate pair", () => {
    const title = (prompt: string) =>
      subagentThreadTitle({ parentTitle: "Parent", prompt, ordinal: 1 });

    expect(title(`${"a".repeat(68)}😀 and more work.`)).toBe(`${"a".repeat(68)}...`);
    expect(title(`${"a".repeat(67)}😀 and more work.`)).toBe(`${"a".repeat(67)}😀...`);
  });
});
