import { expect, it } from "vite-plus/test";
import {
  reviewCommentRange,
  reviewPositionAnchor,
  reviewPositionLabel,
} from "./reviewSelection.ts";

const label = (range: ReturnType<typeof reviewCommentRange>) =>
  reviewPositionLabel(range.position, range.startPosition);

it("retains the start of added, removed and cross-side selections", () => {
  expect(reviewCommentRange({ kind: "added", newLine: 4 }, { kind: "added", newLine: 7 })).toEqual({
    position: { kind: "added", newLine: 7 },
    startPosition: { kind: "added", newLine: 4 },
  });
  expect(
    label(reviewCommentRange({ kind: "deleted", oldLine: 8 }, { kind: "deleted", oldLine: 3 })),
  ).toBe("Old lines 3–8");
  expect(
    reviewCommentRange({ kind: "deleted", oldLine: 4 }, { kind: "added", newLine: 5 }),
  ).toEqual({
    position: { kind: "added", newLine: 5 },
    startPosition: { kind: "deleted", oldLine: 4 },
  });
});

it("keeps single-line comments single and uses the chosen context side", () => {
  const line = { kind: "context", oldLine: 10, newLine: 14, side: "left" } as const;
  expect(reviewCommentRange(line, line)).toEqual({ position: line });
  expect(reviewPositionAnchor(line)).toEqual({ line: 10, side: "left" });
  expect(reviewPositionLabel(line)).toBe("Old line 10");
  expect(reviewPositionLabel(line, line)).toBe("Old line 10");
});

it("labels a selection crossing from the new side to the old side correctly", () => {
  expect(
    label(reviewCommentRange({ kind: "added", newLine: 4 }, { kind: "deleted", oldLine: 5 })),
  ).toBe("Line 4 → old line 5");
});
