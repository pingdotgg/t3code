import { describe, expect, it, vi } from "vite-plus/test";

vi.mock(import("./stripCamera"), () => ({
  moveStripCamera: () => {},
  settleStripCamera: () => {},
}));

import { placeStackRow } from "./workspaceSwitch";

describe("placeStackRow", () => {
  it("keeps every row the stage still crosses on its way to the new one", () => {
    const rows = ["a", "b", "c", "d"].map((id, offset) => ({ id, offset }));
    const placed = (position: number) =>
      placeStackRow(rows, { id: "e", offset: 4 }, rows[3]!, position).map((row) => row.id);

    expect(placed(0.2)).toEqual(["a", "b", "c", "d", "e"]);
    expect(placed(2.9)).toEqual(["c", "d", "e"]);
  });
});
