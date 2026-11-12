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

  it.each(["", " ", "-1", "Infinity", "NaN", "1e999", "$2", "0x10", "1,2,3", "1.2,3", "1,2.3"])(
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

  it("reads a comma as the decimal point", () => {
    const form = usagePriceForm("example-model", {
      inputCostPerMillionTokens: 2,
      outputCostPerMillionTokens: 8,
    });
    expect(
      parseUsagePriceForm({
        ...form,
        inputCostPerMillionTokens: "2,5",
        outputCostPerMillionTokens: "0,075",
      }),
    ).toEqual({
      model: "example-model",
      price: { inputCostPerMillionTokens: 2.5, outputCostPerMillionTokens: 0.075 },
    });
    expect(parseUsagePriceForm({ ...form, inputCostPerMillionTokens: "1,2,3" })).toBeNull();
    expect(isUsagePriceEdit("", "2,5")).toBe(true);
    expect(isUsagePriceEdit("", ",5")).toBe(true);
    expect(isUsagePriceEdit("", "1,2,3")).toBe(false);
    expect(isUsagePriceEdit("1,2", "1,2.3")).toBe(false);
    for (const value of ["2,5", ",5", "0,075", "1,5e-7"]) {
      for (let end = 1; end <= value.length; end++) {
        expect(isUsagePriceEdit(value.slice(0, end - 1), value.slice(0, end))).toBe(true);
      }
    }
  });

  it("never blocks deleting part of a price, but blocks replacing it with a non-number", () => {
    expect(isUsagePriceEdit("1e-7", "e-7")).toBe(true);
    expect(isUsagePriceEdit("1e-7", "1-7")).toBe(true);
    expect(isUsagePriceEdit("1e-7", "a7")).toBe(false);
    expect(isUsagePriceEdit("2.5", "x")).toBe(false);
    expect(isUsagePriceEdit("123456", "1.2.3")).toBe(false);
  });
});
