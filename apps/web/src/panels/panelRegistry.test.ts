import { describe, expect, it, vi } from "vite-plus/test";
import { createPanelRegistry } from "./panelRegistry";

describe("panel registration", () => {
  it("rejects duplicate ids without loading either panel", () => {
    const load = vi.fn();
    const definition = { id: "diff", load } as const;
    expect(() => createPanelRegistry([definition, definition])).toThrow("Duplicate panel id: diff");
    expect(load).not.toHaveBeenCalled();
  });
  it("retains lazy component identity without loading on lookup", () => {
    const load = vi.fn();
    const registry = createPanelRegistry<Record<string, never>, string>([{ id: "diff", load }]);
    expect(registry.get("diff")?.Component).toBe(registry.get("diff")?.Component);
    expect(registry.get("missing")).toBeUndefined();
    expect(load).not.toHaveBeenCalled();
  });
});
