import type { StorageCleanupPreview } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { combineStorageUsage } from "./storageUsage";

const summary = (overrides: Partial<StorageCleanupPreview> = {}): StorageCleanupPreview => ({
  checkedAt: "2026-09-19T12:00:00.000Z",
  unchecked: 0,
  unavailable: 0,
  total: { folders: 2, measured: 2, bytes: 1000 },
  categories: [
    { kind: "inactive", folders: 1, measured: 1, bytes: 600 },
    { kind: "kept", folders: 1, measured: 1, bytes: 400 },
  ],
  projectCount: 1,
  ...overrides,
});

describe("storage usage across machines", () => {
  it("adds physical storage while keeping categories consistent", () => {
    const first = summary();
    const second = summary({ checkedAt: "2026-09-19T11:59:00.000Z" });
    const before = structuredClone([first, second]);
    const combined = combineStorageUsage([first, second])!;
    expect(combined.total).toEqual({ folders: 4, measured: 4, bytes: 2000 });
    expect(combined.projectCount).toBe(2);
    expect(combined.checkedAt).toBe(second.checkedAt);
    expect(combined.categories.reduce((sum, category) => sum + category.bytes, 0)).toBe(
      combined.total.bytes,
    );
    expect([first, second]).toEqual(before);
  });

  it("preserves incomplete measurements from any server", () => {
    const combined = combineStorageUsage([
      summary(),
      summary({
        unchecked: 4,
        unavailable: 1,
        total: { folders: 3, measured: 1, bytes: 200 },
        categories: [
          { kind: "unchanged", folders: 2, measured: 0, bytes: 0 },
          { kind: "unchecked", folders: 1, measured: 1, bytes: 200 },
        ],
      }),
    ])!;
    expect(combined.total).toEqual({ folders: 5, measured: 3, bytes: 1200 });
    expect(combined.unchecked).toBe(4);
    expect(combined.unavailable).toBe(1);
    expect(combined.categories.find((category) => category.kind === "unchecked")?.bytes).toBe(200);
  });

  it("does not report unavailable storage as zero or retain a deselected server", () => {
    expect(combineStorageUsage([])).toBeNull();
    const selected = summary();
    expect(combineStorageUsage([selected])).toEqual(selected);
  });
});
