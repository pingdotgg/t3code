import { expect, it } from "vite-plus/test";
import { readAloudAway, readAloudFollowDelta } from "./readAloudFollow";

const view = { top: 100, height: 1000 };

it("keeps the word in the middle of the feed and pauses after the user scrolls", () => {
  const at = (top: number, userScrolledAt: number | null = null, now = 10_000) =>
    readAloudFollowDelta({ target: { top, height: 20 }, view, userScrolledAt, now });
  expect(at(500)).toEqual({ delta: 0, resumed: true });
  expect(at(1000)).toEqual({ delta: 500, resumed: true });
  expect(at(150)).toEqual({ delta: -350, resumed: true });
  // A recent scroll waits, even with the word in view.
  expect(at(1000, 9_000)).toEqual({ delta: 0, resumed: false });
  // Later, a word scrolled out of view stays put until the user brings it back.
  expect(at(2000, 1_000)).toEqual({ delta: 0, resumed: false });
  expect(at(1000, 1_000)).toEqual({ delta: 500, resumed: true });
});

it("tells which way a word read lies once the feed scrolls it out of view", () => {
  const at = (now: number) =>
    readAloudAway({ target: { top: 500, height: 20 }, offset: 2_000, now, view });
  expect(at(2_000)).toBeNull();
  // Scrolling down 400 moves the word up to 100: its top edge still shows.
  expect(at(2_400)).toBeNull();
  expect(at(2_421)).toBe("above");
  expect(at(1_400)).toBeNull();
  expect(at(1_399)).toBe("below");
});
