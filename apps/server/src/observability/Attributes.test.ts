import { assert, describe, it } from "@effect/vitest";

import { normalizeModelMetricLabel } from "./Attributes.ts";

describe("Attributes", () => {
  it("groups GPT-family models under a shared metric label", () => {
    assert.strictEqual(normalizeModelMetricLabel("gpt-4o"), "gpt");
    assert.strictEqual(normalizeModelMetricLabel("gpt-5.4"), "gpt");
    assert.strictEqual(normalizeModelMetricLabel("claude-sonnet-4"), "claude");
  });
});
