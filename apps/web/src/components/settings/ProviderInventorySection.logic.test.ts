import { describe, expect, it } from "vite-plus/test";

import { countDisabledInventory, inventoryItemDetail } from "./ProviderInventorySection.logic";

describe("countDisabledInventory", () => {
  it("counts every switched-off item", () => {
    expect(countDisabledInventory(undefined)).toBe(0);
    expect(countDisabledInventory({ connectors: ["a", "b"], skills: ["c"] })).toBe(3);
  });
});

describe("inventoryItemDetail", () => {
  it("joins status, tool count and owning plugin", () => {
    expect(
      inventoryItemDetail({
        id: "plugin:design:linear",
        name: "linear",
        status: "needsAuth",
        plugin: "design",
      }),
    ).toBe("Needs sign-in · from design");
    expect(inventoryItemDetail({ id: "g", name: "Gmail", status: "connected", toolCount: 1 })).toBe(
      "Connected · 1 tool",
    );
    expect(inventoryItemDetail({ id: "pdf", name: "pdf" })).toBeNull();
  });
});
