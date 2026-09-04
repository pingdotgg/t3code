import { describe, expect, it } from "vite-plus/test";

import { parseUsagePriceForm, usagePriceForm } from "./usagePriceForm.ts";

describe("model price entry", () => {
  it("preserves exact model IDs and fractional rates", () => {
    expect(
      parseUsagePriceForm({
        ...usagePriceForm(),
        model: "  vendor/Example-Model  ",
        inputCostPerMillionTokens: "2.5",
        outputCostPerMillionTokens: "10",
      }),
    ).toEqual({
      model: "vendor/Example-Model",
      price: { inputCostPerMillionTokens: 2.5, outputCostPerMillionTokens: 10 },
    });
  });

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

  it("rejects invalid optional rates and missing model IDs", () => {
    const form = usagePriceForm("example-model", {
      inputCostPerMillionTokens: 2,
      outputCostPerMillionTokens: 8,
    });
    expect(parseUsagePriceForm({ ...form, cacheReadCostPerMillionTokens: "-1" })).toBeNull();
    expect(parseUsagePriceForm({ ...form, cacheWriteCostPerMillionTokens: "invalid" })).toBeNull();
    expect(parseUsagePriceForm({ ...form, model: " " })).toBeNull();
  });
});
