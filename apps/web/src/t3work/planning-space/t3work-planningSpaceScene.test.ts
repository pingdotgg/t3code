import { describe, expect, it } from "vite-plus/test";

import {
  BAND_THRESHOLDS,
  FRAME_GAP,
  FRAME_WIDTH_BUDGET,
  HOUR_STEPS_SECONDS,
  type PackedFrame,
  type PlanningCamera,
  Z_CAMERA_MAX,
  Z_STORY,
  bandForScale,
  boundsOfFrames,
  planningBandChromeChanged,
  counterScale,
  cursorAnchoredZoom,
  fitCameraToBounds,
  frameHeight,
  orderEpicsByAffinity,
  packMasonry,
  projectPoint,
  scaleForPlane,
  steppedHours,
  unprojectAtStoryPlane,
  zoomedZ,
} from "./t3work-planningSpaceScene";

const VIEWPORT = { width: 1280, height: 760 };

describe("cursor-anchored zoom", () => {
  it("keeps the world point under the cursor fixed across a full zoom sweep", () => {
    let camera: PlanningCamera = { x: 140, y: -60, z: -900 };
    const cursor = { x: 412, y: 188 };
    const anchor = unprojectAtStoryPlane(camera, VIEWPORT, cursor.x, cursor.y);
    for (let i = 0; i < 60; i++) {
      camera = cursorAnchoredZoom(
        camera,
        VIEWPORT,
        cursor.x,
        cursor.y,
        -120,
        -3200,
      );
      const projected = projectPoint(camera, VIEWPORT, anchor, Z_STORY);
      expect(Math.abs(projected.x - cursor.x)).toBeLessThan(1);
      expect(Math.abs(projected.y - cursor.y)).toBeLessThan(1);
    }
    expect(camera.z).toBe(Z_CAMERA_MAX);
  });

  it("zooms at a perceptually constant rate (scale ratio independent of depth)", () => {
    const ratioAt = (z: number) =>
      scaleForPlane(zoomedZ(z, -120, -3200), Z_STORY) / scaleForPlane(z, Z_STORY);
    const far = ratioAt(-2400);
    const mid = ratioAt(-200);
    const near = ratioAt(400);
    expect(Math.abs(far - mid)).toBeLessThan(0.02);
    expect(Math.abs(near - mid)).toBeLessThan(0.02);
  });

  it("clamps to the dynamic floor and the fixed ceiling", () => {
    expect(zoomedZ(-3100, 100000, -3200)).toBe(-3200);
    expect(zoomedZ(580, -100000, -3200)).toBe(Z_CAMERA_MAX);
  });
});

describe("pinch zoom", () => {
  it("keeps the world point under the pinch midpoint fixed", async () => {
    const { pinchZoom } = await import("./t3work-planningSpaceScene");
    let camera: PlanningCamera = { x: 80, y: -40, z: -600 };
    const mid = { x: 500, y: 300 };
    const anchor = unprojectAtStoryPlane(camera, VIEWPORT, mid.x, mid.y);
    for (const ratio of [1.3, 1.3, 0.8, 1.5]) {
      camera = pinchZoom(camera, VIEWPORT, mid.x, mid.y, ratio, -3200);
      const projected = projectPoint(camera, VIEWPORT, anchor, Z_STORY);
      expect(Math.abs(projected.x - mid.x)).toBeLessThan(1);
      expect(Math.abs(projected.y - mid.y)).toBeLessThan(1);
    }
  });

  it("scales the story plane by exactly the clamped ratio", async () => {
    const { pinchZoom } = await import("./t3work-planningSpaceScene");
    const camera: PlanningCamera = { x: 0, y: 0, z: -200 };
    const before = scaleForPlane(camera.z, Z_STORY);
    const after = scaleForPlane(
      pinchZoom(camera, VIEWPORT, 400, 300, 1.5, -3200).z,
      Z_STORY,
    );
    expect(after / before).toBeCloseTo(1.5, 5);
  });

  it("holds epic labels at a readable size when far out", async () => {
    const { epicCounterScale } = await import("./t3work-planningSpaceScene");
    for (const scale of [0.18, 0.25, 0.4, 0.7]) {
      const effective = scale * epicCounterScale(scale);
      expect(effective).toBeGreaterThanOrEqual(0.9);
      expect(effective).toBeLessThanOrEqual(1.0001);
    }
    expect(epicCounterScale(1.4)).toBe(1);
  });
});

describe("depth bands", () => {
  it("matches the spec thresholds and is monotonic", () => {
    expect(bandForScale(0.1)).toBe(0);
    expect(bandForScale(BAND_THRESHOLDS[0])).toBe(1);
    expect(bandForScale(0.7)).toBe(2);
    expect(bandForScale(1.0)).toBe(3);
    expect(bandForScale(1.5)).toBe(4);
    expect(bandForScale(2.4)).toBe(5);
    let previous = -1;
    for (let s = 0.05; s < 2.6; s += 0.01) {
      const band = bandForScale(s);
      expect(band).toBeGreaterThanOrEqual(previous);
      previous = band;
    }
  });

  it("counter-scales within the spec caps in both directions", () => {
    expect(counterScale(0, 0.1)).toBe(3.4);
    expect(counterScale(1, 0.2)).toBe(2.2);
    expect(counterScale(2, 0.65)).toBeCloseTo(0.7 / 0.65, 5);
    expect(counterScale(2, 0.8)).toBe(1);
    expect(counterScale(3, 1.1)).toBe(1);
    expect(counterScale(5, 2.4)).toBeCloseTo(1.3 / 2.4, 5);
    expect(counterScale(5, 1.0)).toBe(1);
  });
});

describe("hour stepper ladder", () => {
  it("walks the ladder up and down and clamps at the ends", () => {
    expect(steppedHours(0, 1)).toBe(1800);
    expect(steppedHours(1800, 1)).toBe(3600);
    expect(steppedHours(3600, -1)).toBe(1800);
    expect(steppedHours(0, -1)).toBe(0);
    expect(steppedHours(86400, 1)).toBe(86400);
  });

  it("snaps off-ladder values (free input) to the nearest step in direction", () => {
    expect(steppedHours(5000, 1)).toBe(7200);
    expect(steppedHours(5000, -1)).toBe(3600);
  });
});

describe("masonry packing", () => {
  const realisticSubtaskCounts = [3, 0, 6, 1, 5, 0, 2, 4, 0, 6, 1, 3];

  function frameRects(frames: PackedFrame[], scale: number) {
    return frames.map((f) => ({
      left: (f.centerX - FRAME_WIDTH_BUDGET / 2) * scale,
      right: (f.centerX + FRAME_WIDTH_BUDGET / 2) * scale,
      top: (f.centerY - f.height / 2) * scale,
      bottom: (f.centerY + f.height / 2) * scale,
    }));
  }

  it("never overlaps frames at any band scale (zoom-independent layout)", () => {
    const items = realisticSubtaskCounts.map((n, i) => ({
      id: `S${i}`,
      height: frameHeight(n),
    }));
    const { frames } = packMasonry(items, [-240, 240], 0);
    for (const scale of [0.2, 0.45, 0.8, 1.1, 1.6, 2.2]) {
      const rects = frameRects(frames, scale);
      for (let a = 0; a < rects.length; a++) {
        for (let b = a + 1; b < rects.length; b++) {
          const ra = rects[a];
          const rb = rects[b];
          if (!ra || !rb) throw new Error("missing rect");
          const overlaps =
            ra.left < rb.right &&
            rb.left < ra.right &&
            ra.top < rb.bottom &&
            rb.top < ra.bottom;
          expect(overlaps).toBe(false);
        }
      }
    }
  });

  it("is deterministic and keeps the configured gap between stacked frames", () => {
    const items = realisticSubtaskCounts.map((n, i) => ({
      id: `S${i}`,
      height: frameHeight(n),
    }));
    const first = packMasonry(items, [-240, 240], 0);
    const second = packMasonry(items, [-240, 240], 0);
    expect(second.frames).toEqual(first.frames);
    const byColumn = new Map<number, PackedFrame[]>();
    for (const f of first.frames) {
      byColumn.set(f.centerX, [...(byColumn.get(f.centerX) ?? []), f]);
    }
    for (const column of byColumn.values()) {
      const sorted = [...column].sort((a, b) => a.centerY - b.centerY);
      for (let i = 1; i < sorted.length; i++) {
        const current = sorted[i];
        const previous = sorted[i - 1];
        if (!current || !previous) throw new Error("missing frame");
        const gap =
          current.centerY -
          current.height / 2 -
          (previous.centerY + previous.height / 2);
        expect(gap).toBeCloseTo(FRAME_GAP, 5);
      }
    }
  });
});

describe("fit camera to bounds", () => {
  it("frames the whole scene inside the viewport with margin", () => {
    const items = Array.from({ length: 40 }, (_, i) => ({
      id: `S${i}`,
      height: frameHeight(i % 7),
    }));
    const { frames } = packMasonry(items, [-1200, -400, 400, 1200], -300);
    const bounds = boundsOfFrames(frames);
    const camera = fitCameraToBounds(bounds, VIEWPORT);
    for (const corner of [
      { x: bounds.minX, y: bounds.minY },
      { x: bounds.maxX, y: bounds.minY },
      { x: bounds.minX, y: bounds.maxY },
      { x: bounds.maxX, y: bounds.maxY },
    ]) {
      const projected = projectPoint(camera, VIEWPORT, corner, Z_STORY);
      expect(projected.x).toBeGreaterThanOrEqual(0);
      expect(projected.x).toBeLessThanOrEqual(VIEWPORT.width);
      expect(projected.y).toBeGreaterThanOrEqual(0);
      expect(projected.y).toBeLessThanOrEqual(VIEWPORT.height);
    }
  });
});

describe("epic affinity ordering", () => {
  it("places linked epics adjacent and is deterministic", () => {
    const counts = new Map([
      ["E-big", 8],
      ["E-linked", 1],
      ["E-mid", 4],
      ["E-lone", 3],
    ]);
    const affinity = new Map([
      ["E-big", new Map([["E-linked", 3]])],
      ["E-linked", new Map([["E-big", 3]])],
    ]);
    const ordered = orderEpicsByAffinity(
      ["E-lone", "E-linked", "E-mid", "E-big"],
      counts,
      affinity,
    );
    expect(ordered[0]).toBe("E-big");
    expect(ordered[1]).toBe("E-linked");
    expect(ordered).toEqual(
      orderEpicsByAffinity(["E-mid", "E-big", "E-lone", "E-linked"], counts, affinity),
    );
  });
});

describe("planningBandChromeChanged", () => {
  it("ignores transitions within the same chrome bucket", () => {
    expect(planningBandChromeChanged(1, 2)).toBe(false);
    expect(planningBandChromeChanged(3, 3)).toBe(false);
  });

  it("reacts to gauge label and full-band chrome boundaries", () => {
    expect(planningBandChromeChanged(2, 3)).toBe(true);
    expect(planningBandChromeChanged(4, 5)).toBe(true);
  });
});

describe("hour ladder sanity", () => {
  it("ladder is strictly increasing", () => {
    for (let i = 1; i < HOUR_STEPS_SECONDS.length; i++) {
      expect(HOUR_STEPS_SECONDS[i] ?? 0).toBeGreaterThan(
        HOUR_STEPS_SECONDS[i - 1] ?? Infinity,
      );
    }
  });
});
