import { describe, expect, it } from "vite-plus/test";

import {
  THREAD_DETAILS_SECTIONS,
  isEmptyThreadDetailsSections,
  resolveThreadDetailsSectionRender,
  threadDetailsItemVisible,
  threadDetailsSectionMode,
} from "./threadDetailsCustomization";

describe("threadDetailsSectionMode", () => {
  it("defaults every section to relevant", () => {
    for (const section of THREAD_DETAILS_SECTIONS) {
      expect(threadDetailsSectionMode({ sections: {} }, section.id)).toBe("relevant");
    }
  });

  it("reads sparse overrides and ignores unknown sections", () => {
    const overrides = {
      sections: {
        lineage: { visibility: "always" },
        automations: { visibility: "hidden" },
      },
    } as const;
    expect(threadDetailsSectionMode(overrides, "automations")).toBe("hidden");
    expect(threadDetailsSectionMode(overrides, "workspace")).toBe("relevant");
  });
});

describe("threadDetailsItemVisible", () => {
  it("defaults items to visible", () => {
    expect(threadDetailsItemVisible({ sections: {} }, "workspace", "branch")).toBe(true);
  });

  it("hides only items explicitly set to false", () => {
    const overrides = {
      sections: {
        workspace: { items: { branch: false, scripts: true } },
      },
    } as const;
    expect(threadDetailsItemVisible(overrides, "workspace", "branch")).toBe(false);
    expect(threadDetailsItemVisible(overrides, "workspace", "scripts")).toBe(true);
    expect(threadDetailsItemVisible(overrides, "workspace", "openIn")).toBe(true);
  });
});

describe("resolveThreadDetailsSectionRender", () => {
  it("never renders hidden sections", () => {
    expect(
      resolveThreadDetailsSectionRender({ mode: "hidden", available: true, hasContent: true }),
    ).toEqual({ render: false, showEmptyState: false });
  });

  it("respects availability gates in every mode", () => {
    for (const mode of ["always", "relevant"] as const) {
      expect(
        resolveThreadDetailsSectionRender({ mode, available: false, hasContent: true }),
      ).toEqual({ render: false, showEmptyState: false });
    }
  });

  it("renders relevant sections only when they have content", () => {
    expect(
      resolveThreadDetailsSectionRender({ mode: "relevant", available: true, hasContent: true }),
    ).toEqual({ render: true, showEmptyState: false });
    expect(
      resolveThreadDetailsSectionRender({ mode: "relevant", available: true, hasContent: false }),
    ).toEqual({ render: false, showEmptyState: false });
  });

  it("keeps always sections visible with a terse empty state", () => {
    expect(
      resolveThreadDetailsSectionRender({ mode: "always", available: true, hasContent: true }),
    ).toEqual({ render: true, showEmptyState: false });
    expect(
      resolveThreadDetailsSectionRender({ mode: "always", available: true, hasContent: false }),
    ).toEqual({ render: true, showEmptyState: true });
  });
});

describe("isEmptyThreadDetailsSections", () => {
  it("is only true for untouched overrides", () => {
    expect(isEmptyThreadDetailsSections({ sections: {} })).toBe(true);
    expect(
      isEmptyThreadDetailsSections({ sections: { workspace: { visibility: "hidden" } } }),
    ).toBe(false);
  });
});
