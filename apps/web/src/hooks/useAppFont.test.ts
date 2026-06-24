import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applySidebarTranslucency } from "./useAppFont";

describe("applySidebarTranslucency", () => {
  let attributes: Map<string, string>;

  beforeEach(() => {
    attributes = new Map();
    vi.stubGlobal("document", {
      documentElement: {
        getAttribute: (name: string) => attributes.get(name) ?? null,
        removeAttribute: (name: string) => {
          attributes.delete(name);
        },
        setAttribute: (name: string, value: string) => {
          attributes.set(name, value);
        },
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("applies the sidebar translucency attribute", () => {
    applySidebarTranslucency("medium");

    expect(document.documentElement.getAttribute("data-sidebar-translucency")).toBe("medium");
  });
});
