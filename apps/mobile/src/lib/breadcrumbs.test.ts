import { describe, expect, it } from "vite-plus/test";

import { addBreadcrumb, breadcrumbCount, clearBreadcrumbs, getBreadcrumbs } from "./breadcrumbs";

describe("breadcrumbs", () => {
  it("records entries in order and exposes a copy", () => {
    clearBreadcrumbs();
    addBreadcrumb("nav", { path: "Home" });
    addBreadcrumb("outbox.dispatch", { messageId: "m1" });

    expect(getBreadcrumbs()).toEqual([
      expect.objectContaining({ type: "nav", data: { path: "Home" } }),
      expect.objectContaining({ type: "outbox.dispatch", data: { messageId: "m1" } }),
    ]);
    expect(breadcrumbCount()).toBe(2);
  });

  it("caps ring size and drops the oldest entries", () => {
    clearBreadcrumbs();
    for (let index = 0; index < 100; index += 1) {
      addBreadcrumb("tick", { index });
    }

    expect(breadcrumbCount()).toBe(80);
    expect(getBreadcrumbs()[0]?.data?.index).toBe(20);
    expect(getBreadcrumbs().at(-1)?.data?.index).toBe(99);
  });

  it("truncates long string values", () => {
    clearBreadcrumbs();
    addBreadcrumb("msg", { text: "x".repeat(250) });

    const text = getBreadcrumbs()[0]?.data?.text;
    expect(typeof text).toBe("string");
    expect(String(text).length).toBeLessThanOrEqual(201);
    expect(String(text).endsWith("…")).toBe(true);
  });
});
