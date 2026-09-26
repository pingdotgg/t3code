import { describe, expect, it } from "vite-plus/test";

import {
  type PlacedElement,
  resolveDropTarget,
  resolveKeyboardMove,
  unionRect,
} from "./customizeEdit.logic";

const at = (id: string, left: number, right: number): PlacedElement => ({
  id,
  rect: { left, right, top: 0, bottom: 20 },
});

// Three header actions in a row: [scripts 0-100] [openIn 110-200] [git 210-400]
const row = [at("git", 210, 400), at("scripts", 0, 100), at("openIn", 110, 200)];

describe("resolveDropTarget", () => {
  it("lands before the first element whose centre is past the pointer", () => {
    expect(resolveDropTarget(row, "git", 40)).toEqual({ beforeId: "scripts", caretX: -3 });
    expect(resolveDropTarget(row, "git", 120)).toEqual({ beforeId: "openIn", caretX: 105 });
  });

  it("lands at the end past the last element", () => {
    expect(resolveDropTarget(row, "scripts", 390)).toEqual({ beforeId: null, caretX: 403 });
  });

  it("ignores the dragged element's own position", () => {
    expect(resolveDropTarget(row, "openIn", 150)).toEqual({ beforeId: "git", caretX: 155 });
  });

  it("has nowhere to go without other elements", () => {
    expect(resolveDropTarget([at("git", 0, 10)], "git", 5)).toBeNull();
  });
});

describe("resolveKeyboardMove", () => {
  const order = ["scripts", "openIn", "git"];

  it("steps left before the left neighbour", () => {
    expect(resolveKeyboardMove(order, "openIn", "left")).toEqual({ beforeId: "scripts" });
  });

  it("steps right past the right neighbour", () => {
    expect(resolveKeyboardMove(order, "scripts", "right")).toEqual({ beforeId: "git" });
    expect(resolveKeyboardMove(order, "openIn", "right")).toEqual({ beforeId: null });
  });

  it("stops at either edge", () => {
    expect(resolveKeyboardMove(order, "scripts", "left")).toBeNull();
    expect(resolveKeyboardMove(order, "git", "right")).toBeNull();
  });
});

describe("unionRect", () => {
  it("spans every non-empty rect", () => {
    expect(
      unionRect([
        { left: 10, top: 5, right: 20, bottom: 15 },
        { left: 0, top: 0, right: 0, bottom: 0 },
        { left: 30, top: 8, right: 40, bottom: 30 },
      ]),
    ).toEqual({ left: 10, top: 5, right: 40, bottom: 30 });
  });

  it("is null when nothing is visible", () => {
    expect(unionRect([{ left: 0, top: 0, right: 0, bottom: 0 }])).toBeNull();
  });
});
