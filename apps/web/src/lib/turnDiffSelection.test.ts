import { expect, it } from "vite-plus/test";
import { canLoadTurnDiff } from "./turnDiffSelection";

it("does not request Git diffs for provider placeholders or failed captures", () => {
  expect(canLoadTurnDiff({ checkpointTurnCount: 2, status: "missing" }, [])).toBe(false);
  expect(canLoadTurnDiff({ checkpointTurnCount: 2, status: "error" }, [])).toBe(false);
  expect(canLoadTurnDiff(undefined, [])).toBe(false);
});

it("requires both snapshots for a turn transition, including turns without changed files", () => {
  const first = { checkpointTurnCount: 1, status: "ready" } as const;
  const second = { checkpointTurnCount: 2, status: "ready" } as const;
  expect(canLoadTurnDiff(first, [first])).toBe(true);
  expect(canLoadTurnDiff(second, [first, second])).toBe(true);
  expect(canLoadTurnDiff(second, [second])).toBe(false);
  expect(canLoadTurnDiff(second, [{ ...first, status: "missing" }, second])).toBe(false);
});
