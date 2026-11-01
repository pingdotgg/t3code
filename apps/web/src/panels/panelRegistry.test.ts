import { describe, expect, it, vi } from "vite-plus/test";
import { createPanelRegistry } from "./panelRegistry";

const metadata = {
  title: "Diff",
  icon: () => null,
  launcherKey: "D",
  unavailableHint: "Unavailable.",
  unavailableReason: "Unavailable here.",
};

describe("panel registration", () => {
  it("rejects duplicate ids without loading either panel", () => {
    const load = vi.fn();
    const definition = { ...metadata, id: "diff", load } as const;
    expect(() => createPanelRegistry([definition, definition])).toThrow("Duplicate panel id: diff");
    expect(load).not.toHaveBeenCalled();
  });
  it("retains lazy component identity without loading on lookup", () => {
    const load = vi.fn();
    const registry = createPanelRegistry([{ ...metadata, id: "diff", load }]);
    expect(registry.get("diff")?.Component).toBe(registry.get("diff")?.Component);
    expect(() => {
      // @ts-expect-error Unknown ids are refused at compile time and at runtime.
      registry.get("missing");
    }).toThrow("Unknown panel id: missing");
    expect(load).not.toHaveBeenCalled();
  });
});
