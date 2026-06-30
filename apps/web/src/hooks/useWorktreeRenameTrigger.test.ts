import type { LocalApi } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { shouldOpenWorktreeRenameFromContextMenu } from "./useWorktreeRenameTrigger";

function makeContextMenu(result: Promise<"rename-worktree" | null>): LocalApi["contextMenu"] {
  return {
    show: vi.fn(() => result),
  } as LocalApi["contextMenu"];
}

describe("shouldOpenWorktreeRenameFromContextMenu", () => {
  const position = { x: 10, y: 20 };

  it("opens when the rename item is selected", async () => {
    await expect(
      shouldOpenWorktreeRenameFromContextMenu(
        makeContextMenu(Promise.resolve("rename-worktree")),
        position,
      ),
    ).resolves.toBe(true);
  });

  it("does not open when the menu is dismissed", async () => {
    await expect(
      shouldOpenWorktreeRenameFromContextMenu(makeContextMenu(Promise.resolve(null)), position),
    ).resolves.toBe(false);
  });

  it("falls back to the dialog when the context-menu bridge rejects", async () => {
    await expect(
      shouldOpenWorktreeRenameFromContextMenu(
        makeContextMenu(Promise.reject(new Error("IPC unavailable"))),
        position,
      ),
    ).resolves.toBe(true);
  });
});
