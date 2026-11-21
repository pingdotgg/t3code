import { AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { checksPickAtom, pickedTicket } from "./checksView";
import { chooseRoot, filesViewAtom } from "./filesView";

describe("the ticket the Checks tab shows", () => {
  it("Given a ticket picked in the tab, when another root is chosen, then the tab follows the root again", () => {
    const registry = AtomRegistry.make();
    registry.set(checksPickAtom, { board: "board-a", ticket: "T-2" });
    expect(pickedTicket(registry.get(checksPickAtom), "board-a")).toBe("T-2");

    chooseRoot(registry, "/p/worktrees/t-1");
    expect(pickedTicket(registry.get(checksPickAtom), "board-a")).toBeNull();
    expect(registry.get(filesViewAtom).root).toBe("/p/worktrees/t-1");
  });

  it("Given a ticket picked on board A, when board B opens, then the tab shows no pick for it", () => {
    const registry = AtomRegistry.make();
    registry.set(checksPickAtom, { board: "board-a", ticket: "T-1" });
    expect(pickedTicket(registry.get(checksPickAtom), "board-b")).toBeNull();
    expect(pickedTicket(registry.get(checksPickAtom), "board-a")).toBe("T-1");
  });
});
