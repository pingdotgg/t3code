import type { PreviewAnnotationPoint } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  addStrokePoint,
  openStrokePath,
  startStroke,
  strokeBounds,
  STROKE_SEGMENTS_PER_PATH,
} from "./AnnotationStroke.ts";

// The Draw tool used to rebuild the whole path and rescan every point on each move.
const fullPath = (points: ReadonlyArray<PreviewAnnotationPoint>): string => {
  let path = `M ${points[0]!.x} ${points[0]!.y}`;
  for (let index = 1; index < points.length - 1; index += 1) {
    const current = points[index]!;
    const next = points[index + 1]!;
    path += ` Q ${current.x} ${current.y} ${(current.x + next.x) / 2} ${(current.y + next.y) / 2}`;
  }
  const last = points[points.length - 1]!;
  return `${path} L ${last.x} ${last.y}`;
};

const fullBounds = (points: ReadonlyArray<PreviewAnnotationPoint>, width: number) => {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const padding = width + 3;
  const left = Math.min(...xs) - padding;
  const top = Math.min(...ys) - padding;
  const right = Math.max(...xs) + padding;
  const bottom = Math.max(...ys) + padding;
  return { x: left, y: top, width: right - left, height: bottom - top };
};

// Each later path starts with a move to where the previous one ended.
const joinPaths = (paths: ReadonlyArray<string>): string =>
  paths
    .map((path, index) => {
      if (index === 0) return path;
      const resume = path.match(/^M (\S+ \S+)/)![1]!;
      expect(paths[index - 1]!.endsWith(` ${resume}`)).toBe(true);
      return path.slice(`M ${resume}`.length);
    })
    .join("");

describe("stroke geometry", () => {
  it("draws the same curve and bounds as a full rescan at every length", () => {
    const points = Array.from({ length: STROKE_SEGMENTS_PER_PATH * 2 + 30 }, (_, index) => ({
      x: index * 3 + ((index * 7) % 11),
      y: 200 + ((index * 13) % 29) - index,
    }));
    const geometry = startStroke(points[0]!);
    const closedPaths: string[] = [];
    for (let index = 1; index < points.length; index += 1) {
      const closedPath = addStrokePoint(geometry, points[index]!);
      if (closedPath !== null) closedPaths.push(closedPath);
      const drawn = points.slice(0, index + 1);
      expect(joinPaths([...closedPaths, openStrokePath(geometry)])).toBe(fullPath(drawn));
      expect(strokeBounds(geometry, 4)).toEqual(fullBounds(drawn, 4));
    }
    expect(closedPaths).toHaveLength(2);
    expect(geometry.points).toEqual(points);
  });

  it("keeps the rewritten path short for a stroke past the engine's argument limit", () => {
    const geometry = startStroke({ x: 0, y: 0 });
    for (let index = 1; index < 250_000; index += 1) {
      addStrokePoint(geometry, { x: index % 800, y: index % 600 });
    }
    expect(strokeBounds(geometry, 4)).toEqual({ x: -7, y: -7, width: 813, height: 613 });
    expect(openStrokePath(geometry).length).toBeLessThan(STROKE_SEGMENTS_PER_PATH * 40);
  });
});
