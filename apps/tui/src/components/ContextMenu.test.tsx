import { describe, expect, it } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { MouseButtons } from "@opentui/core/testing";
import * as React from "react";

import {
  ContextMenu,
  firstContextMenuIndex,
  moveContextMenuIndex,
  resolveContextMenuLayout,
} from "./ContextMenu.tsx";

const items = [
  { id: "rename", label: "Rename thread" },
  { id: "archive", label: "Archive thread", disabled: true },
  { id: "delete", label: "Delete", destructive: true, separatorBefore: true },
] as const;

describe("ContextMenu", () => {
  it("clamps the menu inside the viewport", () => {
    expect(resolveContextMenuLayout(items, { x: 39, y: 11 }, { width: 40, height: 12 })).toEqual({
      x: 20,
      y: 6,
      width: 20,
      height: 6,
    });
  });

  it("keyboard traversal skips disabled items and wraps", () => {
    expect(firstContextMenuIndex(items)).toBe(0);
    expect(moveContextMenuIndex(items, 0, 1)).toBe(2);
    expect(moveContextMenuIndex(items, 2, 1)).toBe(0);
    expect(moveContextMenuIndex(items, 0, -1)).toBe(2);
  });

  it("renders over existing content and runs a clicked item", async () => {
    let clicked = "";
    let closed = false;
    const t = await testRender(
      <box width={40} height={12}>
        <text>conversation underneath</text>
        <ContextMenu
          items={items}
          selectedIndex={0}
          position={{ x: 39, y: 11 }}
          viewport={{ width: 40, height: 12 }}
          onSelectIndex={() => {}}
          onRun={(item) => (clicked = item.id)}
          onClose={() => (closed = true)}
        />
      </box>,
      { width: 40, height: 12 },
    );
    await t.renderOnce();
    const lines = t.captureCharFrame().split("\n");
    expect(lines.some((line) => line.includes("conversation underneath"))).toBe(true);
    expect(t.captureCharFrame()).toContain("Rename thread");
    const deleteRow = lines.findIndex((line) => line.includes("Delete"));
    const deleteColumn = lines[deleteRow]!.indexOf("Delete");
    await t.mockMouse.click(deleteColumn, deleteRow, MouseButtons.LEFT);
    await t.flush();
    expect(clicked).toBe("delete");
    await t.mockMouse.click(0, 0, MouseButtons.LEFT);
    await t.flush();
    expect(closed).toBe(true);
    t.renderer.destroy();
  });
});
