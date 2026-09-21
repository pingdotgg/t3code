import { describe, expect, it } from "vite-plus/test";

import {
  buildMultiSelectThreadContextMenuItems,
  shouldRenderSidebarArchiveAll,
} from "./SidebarArchiveControls.logic";

describe("buildMultiSelectThreadContextMenuItems", () => {
  it("offers bulk archive with the selected count", () => {
    expect(
      buildMultiSelectThreadContextMenuItems({ count: 3, hasArchiveBlockedThread: false }),
    ).toContainEqual({ id: "archive", label: "Archive (3)", disabled: false });
  });

  it("disables bulk archive when a selected thread has active work", () => {
    expect(
      buildMultiSelectThreadContextMenuItems({ count: 2, hasArchiveBlockedThread: true }),
    ).toContainEqual({ id: "archive", label: "Archive (2)", disabled: true });
  });
});

describe("shouldRenderSidebarArchiveAll", () => {
  it("keeps the action mounted only while work exists or a batch is in flight", () => {
    expect(shouldRenderSidebarArchiveAll({ archivableCount: 1, isArchiving: false })).toBe(true);
    expect(shouldRenderSidebarArchiveAll({ archivableCount: 0, isArchiving: true })).toBe(true);
    expect(shouldRenderSidebarArchiveAll({ archivableCount: 0, isArchiving: false })).toBe(false);
  });
});
