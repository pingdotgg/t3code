import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { usagePriceCell, usagePriceTableChanges, type UsagePriceDraft } from "./usagePriceTable";
import type { UsagePriceTarget } from "./usagePriceTargets";

const price = { inputCostPerMillionTokens: 2, outputCostPerMillionTokens: 8 };
const target = (name: string, prices: UsagePriceTarget["prices"]): UsagePriceTarget => ({
  environmentId: EnvironmentId.make(name),
  label: name,
  prices,
  unavailable: null,
});
const draft = (values: UsagePriceDraft["values"]): UsagePriceDraft => ({
  id: "model:example",
  model: "example",
  isNew: false,
  values,
});

describe("price table edits", () => {
  it("shows shared and mixed cells separately, and never treats missing settings as automatic", () => {
    const targets = [
      target("a", { example: price }),
      target("b", { example: { ...price, outputCostPerMillionTokens: 10 } }),
    ];
    expect(usagePriceCell(targets, "example", "inputCostPerMillionTokens").value).toBe("2");
    expect(usagePriceCell(targets, "example", "outputCostPerMillionTokens")).toEqual({
      value: "",
      placeholder: "Mixed",
    });
    expect(usagePriceCell(targets, "example", "cacheReadCostPerMillionTokens")).toEqual({
      value: "",
      placeholder: "Input rate",
    });
    expect(
      usagePriceCell([target("a", {})], "example", "inputCostPerMillionTokens").placeholder,
    ).toBe("Automatic");
    expect(
      usagePriceCell([targets[0]!, target("b", null)], "example", "inputCostPerMillionTokens")
        .placeholder,
    ).toBe("Unavailable");
  });

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

  it("does not write unchanged rates and rejects invalid edited cells", () => {
    const environment = target("a", { example: price });
    expect(
      usagePriceTableChanges(environment, [draft({ inputCostPerMillionTokens: "2.00" })]).changes,
    ).toEqual([]);
    expect(
      usagePriceTableChanges(environment, [draft({ cacheReadCostPerMillionTokens: "-1" })]).errors
        .size,
    ).toBe(1);
    expect(
      usagePriceTableChanges(environment, [draft({ outputCostPerMillionTokens: "" })]).errors.size,
    ).toBe(1);
  });
});
