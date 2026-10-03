import { describe, expect, it } from "vite-plus/test";
import {
  recordThreadDetailsContentHeight,
  resolveThreadDetailsCardDensity,
  resolveThreadDetailsCardLayout,
  type ThreadDetailsContentMeasurement,
} from "./threadDetailsCardLayout";

const lane = { padding: 20, minChatWidth: 640 };
const resolve = (width: number, height: number, previewY: number | null = null) =>
  resolveThreadDetailsCardLayout({
    container: { width, height },
    lane,
    frame: previewY === null ? null : { x: width - 332, y: previewY, width: 320, height: 240 },
  });

describe("workspace card", () => {
  it("pins to the top right at a fixed width", () => {
    expect(resolve(1600, 900)).toEqual({
      x: 1308,
      y: 12,
      width: 280,
      height: 876,
    });
    expect(resolve(1344, 900)).toMatchObject({ x: 1052, width: 280 });
  });
  it("hides when a readable chat lane cannot fit beside it", () => {
    expect(resolve(984, 900)).toMatchObject({ x: 692 });
    expect(resolve(983, 900)).toBeNull();
  });
  it("keeps the card at the top right while the preview is freely dragged vertically", () => {
    for (const y of [12, 170, 250, 400, 648]) {
      expect(resolve(1600, 900, y)).toEqual({ x: 1308, y: 12, width: 280, height: 876 });
    }
  });
  it("keeps full height while a preview stays clear of the card", () => {
    expect(resolve(1344, 900, 600)).toMatchObject({ width: 280, height: 876 });
    expect(
      resolveThreadDetailsCardLayout({
        container: { width: 1600, height: 900 },
        lane,
        frame: { x: 12, y: 100, width: 320, height: 240 },
      })?.height,
    ).toBe(876);
  });
});

describe("card content fitting", () => {
  const place = (previewY: number, previewHeight = 365, overlapsDetailsCard = false) =>
    resolveThreadDetailsCardLayout({
      container: { width: 1584, height: 988 },
      lane,
      frame: { x: 1260, y: previewY, width: 240, height: previewHeight },
      overlapsDetailsCard,
    });
  it("does not fold in response to a drag while the full card can be kept clear", () => {
    for (const y of [12, 170, 225, 240, 340, 380, 611]) {
      const placement = place(y)!;
      expect(placement).toMatchObject({ x: 1292, y: 12, height: 964 });
      expect(resolveThreadDetailsCardDensity(placement.height, { full: 327, compact: 182 })).toBe(
        "full",
      );
    }
  });
  it("folds only after the preview cannot fit around the full card", () => {
    const content = { full: 327, compact: 182 };
    expect(resolveThreadDetailsCardDensity(place(351, 625, true)!.height, content)).toBe("full");
    expect(resolveThreadDetailsCardDensity(place(350, 626, true)!.height, content)).toBe("compact");
    expect(resolveThreadDetailsCardDensity(place(12)!.height, content)).toBe("full");
  });
  it("hides only when the available height cannot hold readable controls", () => {
    expect(place(184, 792, true)).toMatchObject({ y: 12, height: 160 });
    expect(place(183, 793, true)).toBeNull();
  });
  it("keeps all content as a freely moved preview approaches without colliding", () => {
    const content = { full: 162, compact: 126 };
    for (const y of [650, 450, 350, 250]) {
      expect(resolveThreadDetailsCardDensity(resolve(1600, 900, y)!.height, content)).toBe("full");
    }
  });
  it("folds only detail that cannot fit and restores it when space returns", () => {
    const content = { full: 570, compact: 180 };
    expect(resolveThreadDetailsCardDensity(600, content)).toBe("full");
    expect(resolveThreadDetailsCardDensity(400, content)).toBe("compact");
    expect(resolveThreadDetailsCardDensity(170, content)).toBe("essential");
    expect(resolveThreadDetailsCardDensity(570, content)).toBe("full");
  });
  it("measures unseen content before deciding to fold it", () => {
    expect(resolveThreadDetailsCardDensity(300, { full: 0, compact: 0 })).toBe("full");
    expect(resolveThreadDetailsCardDensity(300, { full: 570, compact: 0 })).toBe("compact");
  });
});

describe("card content measurement", () => {
  const key = "environment:thread:280";
  const measure = (
    current: ThreadDetailsContentMeasurement,
    heights: { full?: number; compact?: number },
  ) => {
    let next = current;
    if (heights.full !== undefined)
      next = recordThreadDetailsContentHeight(next, key, "full", heights.full);
    if (heights.compact !== undefined)
      next = recordThreadDetailsContentHeight(next, key, "compact", heights.compact);
    return next;
  };
  const empty = (): ThreadDetailsContentMeasurement => ({
    key,
    heights: { full: 0, compact: 0 },
    latestFull: 0,
  });

  it("keeps full density when opening Previous agents grows the bounded list", () => {
    const collapsed = measure(empty(), { full: 350, compact: 180 });
    // Expanding Previous agents adds its bounded scroll list. It must scroll
    // inside the card instead of growing the remembered full height, which would
    // fold the card and unmount the section the user just opened.
    const expanded = measure(collapsed, { full: 598 });
    expect(expanded.heights.full).toBe(350);
    expect(resolveThreadDetailsCardDensity(560, expanded.heights)).toBe("full");
    // The obstacle still has to clear the real 598px card, not the 350px density
    // baseline, or a floating preview overlaps the expanded lineage.
    expect(expanded.latestFull).toBe(598);
  });

  it("retains the full footprint while compact and refreshes it on restore", () => {
    const expanded = measure(measure(empty(), { full: 350, compact: 180 }), { full: 598 });
    // Folding to compact measures the compact tree; the full footprint survives
    // so the obstacle does not shrink while the card folds to make room.
    const folded = measure(expanded, { compact: 220 });
    expect(folded.heights.compact).toBe(180);
    expect(folded.latestFull).toBe(598);
    // Restoring full re-measures the real tree, and the baseline still folds
    // against the collapsed content when space is tight.
    const restored = measure(folded, { full: 598 });
    expect(restored.latestFull).toBe(598);
    expect(resolveThreadDetailsCardDensity(560, restored.heights)).toBe("full");
    expect(resolveThreadDetailsCardDensity(300, restored.heights)).toBe("compact");
  });

  it("records a smaller full height when the panel legitimately shrinks", () => {
    const measured = measure(empty(), { full: 350 });
    const shrunk = measure(measured, { full: 300 });
    expect(shrunk.heights.full).toBe(300);
    expect(shrunk.latestFull).toBe(300);
    expect(resolveThreadDetailsCardDensity(320, shrunk.heights)).toBe("full");
  });

  it("resets measurements when the card switches measurement key", () => {
    const measured = measure(empty(), { full: 350, compact: 180 });
    const next = recordThreadDetailsContentHeight(measured, "other", "full", 260);
    expect(next).toEqual({ key: "other", heights: { full: 260, compact: 0 }, latestFull: 260 });
  });
});
