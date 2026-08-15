import { describe, expect, it } from "vite-plus/test";

import { parseUsageSearch } from "./usage";

describe("parseUsageSearch", () => {
  it("keeps a non-empty provider instance selection", () => {
    expect(parseUsageSearch({ provider: "codex-work" })).toEqual({ provider: "codex-work" });
  });

  it.each([{}, { provider: "" }, { provider: "   " }, { provider: 12 }])(
    "drops an invalid provider selection from %j",
    (raw) => {
      expect(parseUsageSearch(raw)).toEqual({});
    },
  );

  it("drops an overlong provider selection before it enters route state", () => {
    expect(parseUsageSearch({ provider: "p".repeat(65) })).toEqual({});
  });
});
