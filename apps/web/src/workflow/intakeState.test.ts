import { describe, expect, it } from "vite-plus/test";

import { approvedIntakeTickets, toIntakeDrafts, updateIntakeDraft } from "./intakeState.ts";

describe("intakeState", () => {
  it("converts proposals to included drafts with backward-only dependencies", () => {
    const drafts = toIntakeDrafts([
      { title: "Fix login", description: "Sessions drop" },
      { title: "Add rate limiting", dependsOn: [0, 1, 5] },
    ]);
    expect(drafts).toEqual([
      { title: "Fix login", description: "Sessions drop", include: true, dependsOn: [] },
      { title: "Add rate limiting", description: "", include: true, dependsOn: [0] },
    ]);
  });

  it("updates a single draft immutably", () => {
    const drafts = toIntakeDrafts([{ title: "A" }, { title: "B" }]);
    const updated = updateIntakeDraft(drafts, 1, { include: false, title: "B2" });
    expect(updated[0]).toEqual(drafts[0]);
    expect(updated[1]).toEqual({ title: "B2", description: "", include: false, dependsOn: [] });
  });

  it("returns only approved, non-blank tickets with trimmed fields", () => {
    const drafts = [
      { title: "  Fix login  ", description: "  Sessions drop  ", include: true, dependsOn: [] },
      { title: "Skipped", description: "", include: false, dependsOn: [] },
      { title: "   ", description: "blank title", include: true, dependsOn: [] },
      { title: "No description", description: "   ", include: true, dependsOn: [] },
    ];
    expect(approvedIntakeTickets(drafts)).toEqual([
      { title: "Fix login", description: "Sessions drop", dependsOnIndices: [] },
      { title: "No description", dependsOnIndices: [] },
    ]);
  });

  it("remaps dependency edges onto the approved list and drops excluded targets", () => {
    const drafts = toIntakeDrafts([
      { title: "API" },
      { title: "Skipped" },
      { title: "UI", dependsOn: [0, 1] },
      { title: "Docs", dependsOn: [2] },
    ]);
    const withExclusion = updateIntakeDraft(drafts, 1, { include: false });

    const approved = approvedIntakeTickets(withExclusion);
    expect(approved.map((ticket) => ticket.title)).toEqual(["API", "UI", "Docs"]);
    // UI depended on API (kept, index 0) and Skipped (dropped).
    expect(approved[1]?.dependsOnIndices).toEqual([0]);
    // Docs depended on UI, which is now approved index 1.
    expect(approved[2]?.dependsOnIndices).toEqual([1]);
  });
});
