import { describe, expect, it } from "vite-plus/test";

import { isUsagePriceEdit, parseUsagePriceForm, usagePriceForm } from "./usagePriceForm.ts";

describe("model price entry", () => {
  it("keeps free cache tokens distinct from blank cache prices", () => {
    const parsed = parseUsagePriceForm({
      ...usagePriceForm(),
      model: "example-model",
      inputCostPerMillionTokens: "2",
      outputCostPerMillionTokens: "8",
      cacheReadCostPerMillionTokens: "0",
      cacheWriteCostPerMillionTokens: " ",
    });
    expect(parsed?.price).toEqual({
      inputCostPerMillionTokens: 2,
      outputCostPerMillionTokens: 8,
      cacheReadCostPerMillionTokens: 0,
    });
  });

  it("preserves all prices when editing, including small fractional prices", () => {
    const price = {
      inputCostPerMillionTokens: 0,
      outputCostPerMillionTokens: 8,
      cacheReadCostPerMillionTokens: 0.0000001,
      cacheWriteCostPerMillionTokens: 3.5,
    };
    expect(parseUsagePriceForm(usagePriceForm("example-model", price))).toEqual({
      model: "example-model",
      price,
    });
  });

  it.each(["", " ", "-1", "Infinity", "NaN", "1e999", "$2", "0x10"])(
    "rejects invalid required prices: %j",
    (inputCostPerMillionTokens) => {
      expect(
        parseUsagePriceForm({
          ...usagePriceForm("example-model", {
            inputCostPerMillionTokens: 2,
            outputCostPerMillionTokens: 8,
          }),
          inputCostPerMillionTokens,
        }),
      ).toBeNull();
    },
  );

  it("never blocks deleting part of a price, but blocks replacing it with a non-number", () => {
    expect(isUsagePriceEdit("1e-7", "e-7")).toBe(true);
    expect(isUsagePriceEdit("1e-7", "1-7")).toBe(true);
    expect(isUsagePriceEdit("1e-7", "a7")).toBe(false);
    expect(isUsagePriceEdit("2.5", "x")).toBe(false);
    expect(isUsagePriceEdit("123456", "1.2.3")).toBe(false);
  });
});
