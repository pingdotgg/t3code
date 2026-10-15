import { expect, it } from "vite-plus/test";
import {
  reviewPositionAnchor,
  reviewPositionLabel,
  reviewPositionRange,
} from "./reviewSelection.ts";

it("retains the start of added, removed and cross-side selections", () => {
  expect(reviewPositionRange({ kind: "added", newLine: 4 }, { kind: "added", newLine: 7 })).toEqual(
    { kind: "added", newLine: 7, startLine: 4, startSide: "right" },
  );
  expect(
    reviewPositionLabel(
      reviewPositionRange({ kind: "deleted", oldLine: 8 }, { kind: "deleted", oldLine: 3 }),
    ),
  ).toBe("Old lines 3–8");
  expect(
    reviewPositionRange({ kind: "deleted", oldLine: 4 }, { kind: "added", newLine: 5 }),
  ).toEqual({ kind: "added", newLine: 5, startLine: 4, startSide: "left" });
});
it("keeps single-line comments single and uses the chosen context side", () => {
  const line = { kind: "context", oldLine: 10, newLine: 14, side: "left" } as const;
  expect(reviewPositionRange(line, line)).toEqual(line);
  expect(reviewPositionAnchor(line)).toEqual({ line: 10, side: "left" });
  expect(reviewPositionLabel(line)).toBe("Old line 10");
});

it("labels a selection crossing from the new side to the old side correctly", () => {
  expect(
    reviewPositionLabel(
      reviewPositionRange({ kind: "added", newLine: 4 }, { kind: "deleted", oldLine: 5 }),
    ),
  ).toBe("Line 4 → old line 5");
});
