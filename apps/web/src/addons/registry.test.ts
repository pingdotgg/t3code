import { describe, expect, it } from "vite-plus/test";

import { validateWebAddons } from "./registry";

describe("validateWebAddons", () => {
  it("accepts stable kebab-case ids", () => {
    expect(validateWebAddons([{ id: "fleet-status" }])).toEqual([{ id: "fleet-status" }]);
  });

  it("rejects invalid and duplicate ids", () => {
    expect(() => validateWebAddons([{ id: "Fleet Status" }])).toThrow("Invalid addon id");
    expect(() => validateWebAddons([{ id: "fleet" }, { id: "fleet" }])).toThrow(
      "Duplicate addon id",
    );
  });
});
