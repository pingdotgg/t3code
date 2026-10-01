import { describe, expect, it } from "vite-plus/test";

import { chooseSample, intersectRect } from "./customizeTargets";

describe("intersectRect", () => {
  const viewport = { left: 0, top: 0, right: 800, bottom: 600 };

  it("clips a box that runs past the edge", () => {
    expect(intersectRect({ left: 700, top: 10, right: 900, bottom: 40 }, viewport)).toEqual({
      left: 700,
      top: 10,
      right: 800,
      bottom: 40,
    });
  });

  it("has nothing for a box parked off screen, like a collapsed sidebar row", () => {
    expect(intersectRect({ left: -260, top: 100, right: -10, bottom: 130 }, viewport)).toBeNull();
  });

  it("has nothing for a box that only touches the edge", () => {
    expect(intersectRect({ left: -40, top: 0, right: 0, bottom: 30 }, viewport)).toBeNull();
  });
});

describe("chooseSample", () => {
  const rows = ["a", "b", "c", "d"];
  const scores: Record<string, number> = { a: 1, b: 3, c: 3, d: 2 };
  const score = (row: string) => scores[row] ?? 0;

  it("keeps the current pick while it shows, without walking the candidates", () => {
    let walked = false;
    const candidates = () => {
      walked = true;
      return rows;
    };
    expect(chooseSample("a", candidates, () => true, score)).toBe("a");
    expect(walked).toBe(false);
  });

  it("re-picks the best shown candidate, earliest on ties, once the pick is gone", () => {
    expect(
      chooseSample(
        "a",
        () => rows,
        (row) => row !== "a",
        score,
      ),
    ).toBe("b");
    expect(
      chooseSample(
        null,
        () => rows,
        (row) => row !== "b",
        score,
      ),
    ).toBe("c");
  });

  it("has no pick when nothing shows or nothing scores", () => {
    expect(
      chooseSample(
        "a",
        () => rows,
        () => false,
        score,
      ),
    ).toBeNull();
    expect(
      chooseSample(
        null,
        () => rows,
        () => true,
        () => 0,
      ),
    ).toBeNull();
  });
});
