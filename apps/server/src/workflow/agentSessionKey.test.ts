import { assert, describe, it } from "@effect/vitest";
import { agentKey } from "./agentSessionKey.ts";

describe("agentKey", () => {
  it("is order-independent over options (sorted by id)", () => {
    const a = agentKey("i1", "m1", [
      { id: "effort", value: "high" },
      { id: "tier", value: "x" },
    ]);
    const b = agentKey("i1", "m1", [
      { id: "tier", value: "x" },
      { id: "effort", value: "high" },
    ]);
    assert.equal(a, b);
  });

  it("differs on instance, model, and option changes", () => {
    const base = agentKey("i1", "m1", [{ id: "effort", value: "high" }]);
    assert.notEqual(base, agentKey("i2", "m1", [{ id: "effort", value: "high" }]));
    assert.notEqual(base, agentKey("i1", "m2", [{ id: "effort", value: "high" }]));
    assert.notEqual(base, agentKey("i1", "m1", [{ id: "effort", value: "low" }]));
    assert.notEqual(base, agentKey("i1", "m1", [{ id: "tier", value: "high" }]));
    assert.notEqual(base, agentKey("i1", "m1", []));
    assert.notEqual(base, agentKey("i1", "m1", undefined));
  });

  it("is stable for identical input", () => {
    const opts = [
      { id: "effort", value: "high" as const },
      { id: "verbose", value: true as const },
    ];
    assert.equal(agentKey("i1", "m1", opts), agentKey("i1", "m1", opts));
  });

  it("treats missing options the same as empty", () => {
    assert.equal(agentKey("i1", "m1", undefined), agentKey("i1", "m1", []));
  });
});
