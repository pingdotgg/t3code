import { describe, expect, it } from "vite-plus/test";
import {
  buildRemovalItems,
  type CleanupRowState,
  formatBytes,
  isRowRemovable,
  totalSelectedBytes,
} from "./WorktreeCleanupDialog.logic";

function row(overrides: Partial<CleanupRowState> = {}): CleanupRowState {
  return {
    path: "/wt/a",
    refName: "a",
    classification: "orphaned",
    isDirty: false,
    selected: true,
    force: false,
    sizeBytes: 1024,
    ...overrides,
  };
}

describe("formatBytes", () => {
  it("formats zero", () => expect(formatBytes(0)).toBe("0 B"));
  it("formats kilobytes", () => expect(formatBytes(1024)).toBe("1.0 KB"));
  it("formats megabytes", () => expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB"));
});

describe("totalSelectedBytes", () => {
  it("sums only selected rows with known sizes", () => {
    const rows = [
      row({ sizeBytes: 1024 }),
      row({ selected: false, sizeBytes: 2048 }),
      row({ sizeBytes: null }),
    ];
    expect(totalSelectedBytes(rows)).toBe(1024);
  });
});

describe("isRowRemovable", () => {
  it("blocks active rows", () =>
    expect(isRowRemovable(row({ classification: "active" }))).toBe(false));
  it("blocks dirty rows without force", () =>
    expect(isRowRemovable(row({ isDirty: true, force: false }))).toBe(false));
  it("allows dirty rows with force", () =>
    expect(isRowRemovable(row({ isDirty: true, force: true }))).toBe(true));
  it("blocks deselected rows", () =>
    expect(isRowRemovable(row({ selected: false }))).toBe(false));
});

describe("buildRemovalItems", () => {
  it("forces dirty rows and includes only removable rows", () => {
    const rows = [
      row({ path: "/wt/clean" }),
      row({ path: "/wt/dirty", isDirty: true, force: true }),
      row({ path: "/wt/active", classification: "active" }),
    ];
    expect(buildRemovalItems(rows)).toEqual([
      { path: "/wt/clean", force: false },
      { path: "/wt/dirty", force: true },
    ]);
  });
});
