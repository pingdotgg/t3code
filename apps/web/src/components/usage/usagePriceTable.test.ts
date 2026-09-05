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

  it("ignores empty new rows without blocking other edits", () => {
    const environment = target("a", { example: price });
    const empty: UsagePriceDraft = {
      id: "new:1",
      model: " ",
      isNew: true,
      values: { inputCostPerMillionTokens: " " },
    };
    const plan = usagePriceTableChanges(environment, [
      draft({ inputCostPerMillionTokens: "3" }),
      empty,
    ]);
    expect(plan.errors.size).toBe(0);
    expect(plan.changes).toEqual([
      { model: "example", price: { ...price, inputCostPerMillionTokens: 3 } },
    ]);
    expect(usagePriceTableChanges(environment, [empty]).changes).toEqual([]);
    expect(
      usagePriceTableChanges(environment, [
        { ...empty, values: { inputCostPerMillionTokens: "0" } },
      ]).errors.get(empty.id),
    ).toBe("Enter a model ID.");
  });

  it.each(["Offline", "Read-only access", "Update server to edit prices"])(
    "does not let %s destinations block a valid edit elsewhere",
    (unavailable) => {
      const edits = [draft({ inputCostPerMillionTokens: "3" })];
      const writable = target("writable", { example: price });
      const other = target("other", {});
      expect(usagePriceTableErrors([writable, { ...other, unavailable }], edits).size).toBe(0);
      expect(usagePriceTableErrors([writable, other], edits).has("model:example")).toBe(true);
    },
  );

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
