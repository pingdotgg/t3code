import { describe, expect, it } from "vite-plus/test";

import { resolveAssignedThreadLabels, type ThreadLabel } from "./threadLabels";

const labels: readonly ThreadLabel[] = [
  { id: "label-first-created", name: "First created", color: "#2563eb" },
  { id: "label-second-created", name: "Second created", color: "#7c3aed" },
  { id: "label-third-created", name: "Third created", color: "#db2777" },
];

describe("resolveAssignedThreadLabels", () => {
  it("preserves each thread's assignment order instead of catalog order", () => {
    expect(
      resolveAssignedThreadLabels(labels, [
        "label-third-created",
        "label-first-created",
        "label-second-created",
      ]).map((label) => label.id),
    ).toEqual(["label-third-created", "label-first-created", "label-second-created"]);
  });

  it("ignores stale assignment ids without disturbing the remaining order", () => {
    expect(
      resolveAssignedThreadLabels(labels, [
        "label-second-created",
        "label-deleted",
        "label-second-created",
        "label-first-created",
      ]).map((label) => label.id),
    ).toEqual(["label-second-created", "label-first-created"]);
  });
});
