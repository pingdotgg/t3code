import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../state/queries", () => ({
  useComposerPathSearch: () => ({ entries: [], isPending: false }),
}));

import { composerSelectionAtEnd } from "./use-composer-command-menu";

describe("composerSelectionAtEnd", () => {
  it("resets a changed draft owner to the new draft end", () => {
    expect(composerSelectionAtEnd("queued task 🧪")).toEqual({ start: 14, end: 14 });
  });
});
