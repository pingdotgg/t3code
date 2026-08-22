import { describe, expect, it } from "@effect/vitest";

import { lookupRate, parseRateTable, rateTableModelCount } from "./usagePricing.ts";

const rate = (input: number, output = input * 2, cacheRead = input, cacheCreation = input) => ({
  input_cost_per_token: input,
  output_cost_per_token: output,
  cache_read_input_token_cost: cacheRead,
  cache_creation_input_token_cost: cacheCreation,
});

describe("usage pricing", () => {
  it("prefers a canonical model rate over provider-qualified aliases regardless of entry order", () => {
    const canonical = {
      input_cost_per_token: 1,
      output_cost_per_token: 2,
      cache_read_input_token_cost: 0.1,
      cache_creation_input_token_cost: 1.25,
    };
    const providerQualified = {
      input_cost_per_token: 10,
      output_cost_per_token: 20,
    };

    const canonicalFirst = parseRateTable({
      "gpt-5": canonical,
      "replicate/openai/gpt-5": providerQualified,
    });
    const providerFirst = parseRateTable({
      "replicate/openai/gpt-5": providerQualified,
      "gpt-5": canonical,
    });

    expect(lookupRate(canonicalFirst, "gpt-5")).toEqual({
      inputCostPerToken: 1,
      outputCostPerToken: 2,
      cacheReadCostPerToken: 0.1,
      cacheCreationCostPerToken: 1.25,
    });
    expect(lookupRate(providerFirst, "gpt-5")).toEqual(lookupRate(canonicalFirst, "gpt-5"));
  });

  it("keeps provider-qualified rates distinct instead of guessing an ambiguous bare rate", () => {
    const table = parseRateTable({
      "provider-a/example-model": {
        input_cost_per_token: 1,
        output_cost_per_token: 2,
      },
      "provider-b/example-model": {
        input_cost_per_token: 3,
        output_cost_per_token: 4,
      },
    });

    expect(lookupRate(table, "provider-a/example-model")?.inputCostPerToken).toBe(1);
    expect(lookupRate(table, "provider-b/example-model")?.inputCostPerToken).toBe(3);
    expect(lookupRate(table, "example-model")).toBeNull();
  });

  it("keeps a unique provider-qualified entry available through its bare alias", () => {
    const table = parseRateTable({
      "provider-a/example-model": {
        input_cost_per_token: 1,
        output_cost_per_token: 2,
      },
    });

    expect(lookupRate(table, "example-model")).toEqual(
      lookupRate(table, "provider-a/example-model"),
    );
    expect(rateTableModelCount(table)).toBe(1);
  });

  it("does not fall back to a bare alias when a provider-qualified lookup misses", () => {
    const table = parseRateTable({
      "example-model": rate(1),
      "provider-a/example-model": rate(3),
    });

    expect(lookupRate(table, "provider-b/example-model")).toBeNull();
  });

  it("prefers the canonical raw spelling for normalized bare-key duplicates in either order", () => {
    const canonical = ["example-model", rate(1, 2, 0.1, 1.25)] as const;
    const variant = [" Example-Model ", rate(10, 20, 5, 15)] as const;

    for (const entries of [
      [canonical, variant],
      [variant, canonical],
    ]) {
      const table = parseRateTable(Object.fromEntries(entries));
      expect(lookupRate(table, "example-model")).toEqual({
        inputCostPerToken: 1,
        outputCostPerToken: 2,
        cacheReadCostPerToken: 0.1,
        cacheCreationCostPerToken: 1.25,
      });
      expect(rateTableModelCount(table)).toBe(1);
    }
  });

  it("prefers the canonical raw spelling for normalized qualified-key duplicates in either order", () => {
    const canonical = ["provider-a/example-model", rate(1, 2, 0.1, 1.25)] as const;
    const variant = [" Provider-A/Example-Model ", rate(10, 20, 5, 15)] as const;

    for (const entries of [
      [canonical, variant],
      [variant, canonical],
    ]) {
      const table = parseRateTable(Object.fromEntries(entries));
      expect(lookupRate(table, "provider-a/example-model")).toEqual({
        inputCostPerToken: 1,
        outputCostPerToken: 2,
        cacheReadCostPerToken: 0.1,
        cacheCreationCostPerToken: 1.25,
      });
      expect(lookupRate(table, "example-model")).toEqual(
        lookupRate(table, "provider-a/example-model"),
      );
      expect(rateTableModelCount(table)).toBe(1);
    }
  });

  it("drops ambiguous normalized duplicates when neither has canonical provenance", () => {
    const cases = [
      ["Example-Model", " EXAMPLE-MODEL ", "example-model"],
      ["Provider-A/Example-Model", " PROVIDER-A/EXAMPLE-MODEL ", "provider-a/example-model"],
    ] as const;

    for (const [firstName, secondName, lookup] of cases) {
      const first = [firstName, rate(1)] as const;
      const second = [secondName, rate(10)] as const;
      for (const entries of [
        [first, second],
        [second, first],
      ]) {
        const table = parseRateTable(Object.fromEntries(entries));
        expect(lookupRate(table, lookup)).toBeNull();
        expect(rateTableModelCount(table)).toBe(0);
      }
    }
  });
});
