import { describe, expect, it, vi } from "vite-plus/test";

import { readSidebarThreadInventory } from "./sidebarInventory";
import { syncSidebarOlderMembership, useSidebarOlderMembership } from "./sidebarOlderMembership";

vi.mock("./sidebarInventory", () => ({ readSidebarThreadInventory: vi.fn() }));

describe("sidebar older project membership", () => {
  it("stops retrying when the sidebar no longer needs the inventory", async () => {
    vi.useFakeTimers();
    const read = vi.mocked(readSidebarThreadInventory).mockResolvedValue(null);
    const older = {
      before: "2026-01-05T00:00:00.000Z",
      beforeMs: Date.parse("2026-01-05T00:00:00.000Z"),
      counts: new Map(),
    };
    try {
      syncSidebarOlderMembership([{ environmentId: "clone", older }]);
      await vi.advanceTimersByTimeAsync(0);
      expect(read).toHaveBeenCalledTimes(1);
      expect(useSidebarOlderMembership.getState().reading.has("clone")).toBe(true);

      syncSidebarOlderMembership([]);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(read).toHaveBeenCalledTimes(1);
      expect(useSidebarOlderMembership.getState().reading.size).toBe(0);
    } finally {
      syncSidebarOlderMembership([]);
      vi.useRealTimers();
    }
  });
});
