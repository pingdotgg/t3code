import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_SIDEBAR_THREAD_ROW_LAYOUT,
} from "@t3tools/contracts/settings";
import {
  changeSavedThreadLayout,
  resolveSavedThreadLayouts,
  STANDARD_THREAD_LAYOUT,
  COMPACT_THREAD_LAYOUT,
} from "./savedThreadLayouts";

const original = {
  ...DEFAULT_CLIENT_SETTINGS,
  sidebarThreadRowLayoutMode: "custom" as const,
  sidebarThreadRowLayout: [{ component: "title", row: 2, alignment: "right" }] as const,
};

describe("saved thread layouts", () => {
  it("rejects renaming to another saved or built-in layout name", () => {
    const first = changeSavedThreadLayout(original, {
      type: "create",
      id: "one",
      duplicate: false,
    })!;
    const second = changeSavedThreadLayout(first, { type: "create", id: "two", duplicate: false })!;
    for (const name of ["Layout", "Standard", "Compact"]) {
      expect(changeSavedThreadLayout(second, { type: "rename", id: "unused", name })).toBeNull();
    }
  });
  it("preserves the pre-existing arrangement when creating a fresh layout", () => {
    const next = changeSavedThreadLayout(original, {
      type: "create",
      id: "new",
      duplicate: false,
    })!;
    expect(next.sidebarThreadRowLayout).toEqual(DEFAULT_SIDEBAR_THREAD_ROW_LAYOUT);
    expect(next.sidebarSavedThreadLayouts[0]?.layout).toEqual(original.sidebarThreadRowLayout);
    const restored = changeSavedThreadLayout(next, { type: "select", id: "current" });
    expect(restored?.sidebarThreadRowLayout).toEqual(original.sidebarThreadRowLayout);
  });

  it("edits a duplicate independently and restores both arrangements when switching", () => {
    const copy = changeSavedThreadLayout(original, {
      type: "create",
      id: "copy",
      duplicate: true,
    })!;
    const edited = changeSavedThreadLayout(copy, {
      type: "edit",
      id: "unused",
      layout: DEFAULT_SIDEBAR_THREAD_ROW_LAYOUT,
    })!;
    const first = changeSavedThreadLayout(edited, { type: "select", id: "current" })!;
    expect(first.sidebarThreadRowLayout).toEqual(original.sidebarThreadRowLayout);
    expect(
      changeSavedThreadLayout(first, { type: "select", id: "copy" })?.sidebarThreadRowLayout,
    ).toEqual(DEFAULT_SIDEBAR_THREAD_ROW_LAYOUT);
    expect(original.sidebarThreadRowLayout[0]?.row).toBe(2);
  });

  it("renames, deletes and selects a surviving layout, and falls back to Standard after deleting the last custom layout", () => {
    const copy = changeSavedThreadLayout(original, {
      type: "create",
      id: "copy",
      duplicate: true,
    })!;
    const renamed = changeSavedThreadLayout(copy, {
      type: "rename",
      id: "renamed",
      name: "  Focus  ",
    })!;
    expect(resolveSavedThreadLayouts(renamed).current.name).toBe("Focus");
    const remaining = changeSavedThreadLayout(renamed, { type: "delete" })!;
    expect(remaining.sidebarActiveThreadLayoutId).toBe("current");
    expect(remaining.sidebarThreadRowLayout).toEqual(original.sidebarThreadRowLayout);
    const empty = changeSavedThreadLayout(remaining, { type: "delete" })!;
    expect(empty.sidebarSavedThreadLayouts).toEqual([]);
    expect(resolveSavedThreadLayouts(empty).current.name).toBe("Standard");
    expect(changeSavedThreadLayout(empty, { type: "delete" })).toBeNull();
    expect(
      changeSavedThreadLayout(remaining, { type: "rename", id: "renamed", name: " " }),
    ).toBeNull();
    expect(changeSavedThreadLayout(remaining, { type: "select", id: "missing" })).toBeNull();
  });

  it("gives new layouts distinct names and retains saved layouts when selection is missing", () => {
    const first = changeSavedThreadLayout(original, {
      type: "create",
      id: "one",
      duplicate: false,
    })!;
    const second = changeSavedThreadLayout(first, { type: "create", id: "two", duplicate: false })!;
    expect(resolveSavedThreadLayouts(second).current.name).toBe("Layout 2");
    const orphaned = resolveSavedThreadLayouts({ ...second, sidebarActiveThreadLayoutId: null });
    expect(orphaned.layouts.map((item) => item.id)).toEqual([
      "preset:standard",
      "preset:compact",
      "current",
      "one",
      "two",
    ]);
    expect(
      changeSavedThreadLayout(second, { type: "create", id: "one", duplicate: false }),
    ).toBeNull();
  });
});

describe("built-in thread layouts", () => {
  it("offers both presets without creating a custom layout, including legacy compact settings", () => {
    const initial = resolveSavedThreadLayouts(DEFAULT_CLIENT_SETTINGS);
    expect(initial.layouts).toEqual([STANDARD_THREAD_LAYOUT, COMPACT_THREAD_LAYOUT]);
    expect(initial.current).toBe(STANDARD_THREAD_LAYOUT);
    expect(
      resolveSavedThreadLayouts({ ...DEFAULT_CLIENT_SETTINGS, sidebarCompactThreadRows: true })
        .current,
    ).toBe(COMPACT_THREAD_LAYOUT);
  });

  it.each([STANDARD_THREAD_LAYOUT, COMPACT_THREAD_LAYOUT])(
    "forks $name on its first edit and keeps subsequent edits in that copy",
    (preset) => {
      const selected = changeSavedThreadLayout(original, { type: "select", id: preset.id })!;
      const layout = [
        ...preset.layout,
        { component: "model", row: 2, alignment: "right" } as const,
      ];
      const edited = changeSavedThreadLayout(selected, { type: "edit", id: "fork", layout })!;
      expect(edited.sidebarThreadRowLayoutMode).toBe("custom");
      expect(edited.sidebarActiveThreadLayoutId).toBe("fork");
      expect(resolveSavedThreadLayouts(edited).current.name).toBe(`${preset.name} copy`);
      expect(edited.sidebarThreadRowLayout).toEqual(layout);
      expect(edited.sidebarSavedThreadLayouts.map((item) => item.id)).toEqual(["current", "fork"]);
      const again = changeSavedThreadLayout(edited, {
        type: "edit",
        id: "unused",
        layout: [{ component: "title", row: 1, alignment: "left" }],
      })!;
      expect(again.sidebarActiveThreadLayoutId).toBe("fork");
      expect(again.sidebarSavedThreadLayouts).toHaveLength(2);
      const restored = changeSavedThreadLayout(again, { type: "select", id: preset.id })!;
      expect(resolveSavedThreadLayouts(restored).current).toEqual(preset);
      expect(restored.sidebarThreadRowLayoutMode).toBe(
        preset === STANDARD_THREAD_LAYOUT ? "standard" : "compact",
      );
      expect(
        changeSavedThreadLayout(restored, { type: "select", id: "current" })
          ?.sidebarThreadRowLayout,
      ).toEqual(original.sidebarThreadRowLayout);
    },
  );

  it("does not fork a preset for a no-op edit or cancelled drag", () => {
    expect(
      changeSavedThreadLayout(DEFAULT_CLIENT_SETTINGS, {
        type: "edit",
        id: "fork",
        layout: STANDARD_THREAD_LAYOUT.layout.map((item) => ({ ...item })),
      }),
    ).toBeNull();
  });

  it("creates distinct names when editing the same preset again", () => {
    const layout = [{ component: "title", row: 1, alignment: "left" }] as const;
    const first = changeSavedThreadLayout(DEFAULT_CLIENT_SETTINGS, {
      type: "edit",
      id: "one",
      layout,
    })!;
    const selected = changeSavedThreadLayout(first, {
      type: "select",
      id: STANDARD_THREAD_LAYOUT.id,
    })!;
    const second = changeSavedThreadLayout(selected, { type: "edit", id: "two", layout })!;
    expect(resolveSavedThreadLayouts(second).current.name).toBe("Standard copy 2");
    expect(second.sidebarSavedThreadLayouts).toHaveLength(2);
  });

  it("copies a preset when renaming or duplicating it and never deletes a built-in", () => {
    const renamed = changeSavedThreadLayout(DEFAULT_CLIENT_SETTINGS, {
      type: "rename",
      id: "named",
      name: "Focus",
    })!;
    expect(resolveSavedThreadLayouts(renamed).current).toEqual({
      id: "named",
      name: "Focus",
      layout: STANDARD_THREAD_LAYOUT.layout,
    });
    const copy = changeSavedThreadLayout(DEFAULT_CLIENT_SETTINGS, {
      type: "create",
      id: "copy",
      duplicate: true,
    })!;
    expect(copy.sidebarThreadRowLayout).toEqual(STANDARD_THREAD_LAYOUT.layout);
    expect(changeSavedThreadLayout(DEFAULT_CLIENT_SETTINGS, { type: "delete" })).toBeNull();
    expect(
      changeSavedThreadLayout(DEFAULT_CLIENT_SETTINGS, {
        type: "edit",
        id: STANDARD_THREAD_LAYOUT.id,
        layout: COMPACT_THREAD_LAYOUT.layout,
      }),
    ).toBeNull();
  });
});
