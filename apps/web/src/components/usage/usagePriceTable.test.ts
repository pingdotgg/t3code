import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  usagePriceCell,
  usagePriceTableChanges,
  usagePriceTableErrors,
  type UsagePriceDraft,
} from "./usagePriceTable";
import type { UsagePriceTarget } from "./usagePriceTargets";

const price = { inputCostPerMillionTokens: 2, outputCostPerMillionTokens: 8 };
const target = (
  name: string,
  prices: UsagePriceTarget["prices"],
  aliases: UsagePriceTarget["aliases"] = {},
): UsagePriceTarget => ({
  environmentId: EnvironmentId.make(name),
  label: name,
  prices,
  aliases,
  unavailable: null,
});
const draft = (values: UsagePriceDraft["values"]): UsagePriceDraft => ({
  id: "model:example",
  model: "example",
  isNew: false,
  values,
});

describe("price table edits", () => {
  it.each(["constructor", "toString", "__proto__"])(
    "handles an exact model ID named %s",
    (model) => {
      const environment = target("a", {});
      expect(usagePriceCell([environment], model, "inputCostPerMillionTokens")).toEqual({
        value: "",
        placeholder: "Automatic",
      });
      const result = usagePriceTableChanges(environment, [
        {
          ...draft({ inputCostPerMillionTokens: "2", outputCostPerMillionTokens: "8" }),
          model,
          isNew: true,
        },
      ]);
      expect(result.changes).toEqual([{ model, price }]);
      expect(
        usagePriceCell([target("a", { [model]: price })], model, "inputCostPerMillionTokens").value,
      ).toBe("2");
    },
  );

  it("changes only edited columns while preserving each environment's other prices and models", () => {
    const edits = [draft({ inputCostPerMillionTokens: "3" })];
    const a = usagePriceTableChanges(
      target("a", { example: { ...price, cacheReadCostPerMillionTokens: 0 }, untouched: price }),
      edits,
    );
    const b = usagePriceTableChanges(
      target("b", { example: { ...price, outputCostPerMillionTokens: 10 } }),
      edits,
    );
    expect(a.changes).toEqual([
      {
        model: "example",
        price: { ...price, inputCostPerMillionTokens: 3, cacheReadCostPerMillionTokens: 0 },
      },
    ]);
    expect(b.changes).toEqual([
      { model: "example", price: { inputCostPerMillionTokens: 3, outputCostPerMillionTokens: 10 } },
    ]);
  });

  it("batches new rows and resets, and distinguishes blank cache rates from explicit zero", () => {
    const plan = usagePriceTableChanges(target("a", { example: price }), [
      { ...draft({}), removed: true },
      {
        id: "new:1",
        model: "  vendor/Model  ",
        isNew: true,
        values: {
          inputCostPerMillionTokens: "2",
          outputCostPerMillionTokens: "8",
          cacheReadCostPerMillionTokens: "0",
          cacheWriteCostPerMillionTokens: "",
        },
      },
    ]);
    expect(plan.errors.size).toBe(0);
    expect(plan.changes).toEqual([
      { model: "example", price: null },
      { model: "vendor/Model", price: { ...price, cacheReadCostPerMillionTokens: 0 } },
    ]);
  });

  it("requires complete prices before turning automatic pricing into an override", () => {
    const edits = [draft({ inputCostPerMillionTokens: "3" })];
    expect(usagePriceTableChanges(target("a", { example: price }), edits).errors.size).toBe(0);
    const missing = usagePriceTableChanges(target("b", {}), edits);
    expect(missing.changes).toEqual([]);
    expect(missing.errors.has("model:example")).toBe(true);
  });

  it("mapping a model drops its own price and resetting removes the mapping", () => {
    const priced = target("a", { example: price });
    expect(usagePriceTableChanges(priced, [{ ...draft({}), alias: " example-model " }])).toEqual({
      changes: [
        { model: "example", alias: "example-model" },
        { model: "example", price: null },
      ],
      errors: new Map(),
    });
    const mapped = target("b", {}, { example: "example-model" });
    expect(usagePriceTableChanges(mapped, [{ ...draft({}), removed: true }]).changes).toEqual([
      { model: "example", alias: null },
    ]);
    expect(
      usagePriceTableChanges(mapped, [{ ...draft({}), alias: "example" }]).errors.get(
        "model:example",
      ),
    ).toBe("Map to a different model.");
  });
});

describe("model mapping validation", () => {
  const mapping = (model: string, alias: string): UsagePriceDraft => ({
    id: `model:${model}`,
    model,
    alias,
    isNew: false,
    values: {},
  });

  it("rejects a cycle created by several mappings in one save", () => {
    const edits = [mapping("a", "b"), mapping("b", "c"), mapping("c", "a")];
    const result = usagePriceTableChanges(target("local", {}), edits);
    expect([...result.errors.keys()]).toEqual(["model:a", "model:b", "model:c"]);
  });

  it("checks each environment's saved chain when an edited mapping closes it", () => {
    const edits = [mapping("c", "a")];
    const acyclic = target("one", {}, { a: "b" });
    const cyclic = target("two", {}, { a: "b", b: "c" });
    expect(usagePriceTableChanges(acyclic, edits).errors.size).toBe(0);
    expect(usagePriceTableErrors([acyclic, cyclic], edits).get("model:c")).toBe(
      "Model mappings cannot form a cycle on two.",
    );
  });

  it("validates the final batch so a mapping can be reversed in either row order", () => {
    const environment = target("local", {}, { constructor: "__proto__" });
    const clear = mapping("constructor", "");
    const reverse = mapping("__proto__", "constructor");
    for (const edits of [
      [reverse, clear],
      [clear, reverse],
    ]) {
      const result = usagePriceTableChanges(environment, edits);
      expect(result.errors.size).toBe(0);
      expect(result.changes).toEqual(
        edits.map(({ model, alias }) => ({ model, alias: alias || null })),
      );
    }
  });
});
