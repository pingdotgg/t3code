import { describe, expect, it } from "@effect/vitest";

import { lookupRate, parseRateTable } from "./usagePricing.ts";

describe("lookupRate aliasing", () => {
  const table = parseRateTable({
    "gpt-5": { input_cost_per_token: 0.00001, output_cost_per_token: 0.00003 },
    "daybreak-blue-latest": { input_cost_per_token: 0.000002, output_cost_per_token: 0.000006 },
    "daybreak-red-latest": { input_cost_per_token: 0.000003, output_cost_per_token: 0.000009 },
  });

  it("resolves Codex's gpt-prefixed Daybreak blue name to LiteLLM's unprefixed rate", () => {
    const rate = lookupRate(table, "gpt-daybreak-blue-latest");

    expect(rate).toEqual(table.get("daybreak-blue-latest"));
  });

  it("resolves Codex's gpt-prefixed Daybreak red name to LiteLLM's unprefixed rate", () => {
    const rate = lookupRate(table, "gpt-daybreak-red-latest");

    expect(rate).toEqual(table.get("daybreak-red-latest"));
  });

  it("is case-insensitive, consistent with normalizeModelName's lowercasing", () => {
    const rate = lookupRate(table, "GPT-Daybreak-Blue-Latest");

    expect(rate).toEqual(table.get("daybreak-blue-latest"));
  });

  it("leaves a real gpt-prefixed model to look up under its own key, unrewritten", () => {
    const rate = lookupRate(table, "gpt-5");

    expect(rate).toEqual(table.get("gpt-5"));
  });

  it("does not invent a rate for a real gpt model absent from the table", () => {
    // Guards against a generic "strip gpt- prefix" implementation, which would
    // wrongly send "gpt-4" lookups at a hypothetical "4" table entry.
    expect(lookupRate(table, "gpt-4")).toBeNull();
  });
});
