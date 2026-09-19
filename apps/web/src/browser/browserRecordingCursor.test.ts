import { describe, expect, it } from "vite-plus/test";

import type { DesktopPreviewPointerEvent } from "@t3tools/contracts";

import {
  BROWSER_RECORDING_CURSOR_ACTIVE_MS,
  BROWSER_RECORDING_CURSOR_PING_MS,
  drawRecordingCursor,
  resolveFrameDrawRect,
  resolveRecordingCursorPlacement,
} from "./browserRecordingCursor";

const NOW_MS = 1_800_000_000_000;

const pointerEvent = (overrides: {
  readonly phase?: "move" | "click";
  readonly x?: number;
  readonly y?: number;
  readonly ageMs?: number;
}): DesktopPreviewPointerEvent => ({
  tabId: "recording-tab",
  phase: overrides.phase ?? "move",
  x: overrides.x ?? 100,
  y: overrides.y ?? 150,
  sequence: 1,
  createdAt: new Date(NOW_MS - (overrides.ageMs ?? 0)).toISOString(),
});

const source = (overrides?: {
  readonly event?: DesktopPreviewPointerEvent;
  readonly contentWidth?: number;
  readonly contentHeight?: number;
  readonly scale?: number;
  readonly zoomFactor?: number;
  readonly frameWidth?: number;
  readonly frameHeight?: number;
  readonly controller?: "human" | "agent" | "none";
}) => ({
  event: overrides?.event ?? pointerEvent({}),
  content: {
    width: overrides?.contentWidth ?? 800,
    height: overrides?.contentHeight ?? 600,
    scale: overrides?.scale ?? 1,
  },
  zoomFactor: overrides?.zoomFactor ?? 1,
  frameWidth: overrides?.frameWidth ?? 800,
  frameHeight: overrides?.frameHeight ?? 600,
  controller: overrides?.controller ?? "agent",
  nowMs: NOW_MS,
});

describe("resolveRecordingCursorPlacement", () => {
  it("maps guest viewport pixels onto the captured frame", () => {
    const placement = resolveRecordingCursorPlacement(source());
    expect(placement).toMatchObject({ x: 100, y: 150, size: 20, opacity: 1 });
  });

  it("cancels zoom and presentation scale out of the relative position", () => {
    const placement = resolveRecordingCursorPlacement(
      source({ contentWidth: 400, contentHeight: 300, scale: 0.5, zoomFactor: 2 }),
    );
    // The event stays at the same relative position, so a 2x frame lands at 2x pixels.
    expect(placement).toMatchObject({ x: 200, y: 300, size: 40 });
  });

  it("clamps positions to the captured frame", () => {
    const placement = resolveRecordingCursorPlacement(
      source({ event: pointerEvent({ x: 10_000, y: -50 }) }),
    );
    expect(placement).toMatchObject({ x: 800, y: 0 });
  });

  it("dims the cursor once the pointer event goes stale", () => {
    const active = resolveRecordingCursorPlacement(source());
    const idle = resolveRecordingCursorPlacement(
      source({ event: pointerEvent({ ageMs: BROWSER_RECORDING_CURSOR_ACTIVE_MS + 1 }) }),
    );
    expect(active?.opacity).toBe(1);
    expect(idle?.opacity).toBe(0.35);
  });

  it("expands the click ping only for fresh click events", () => {
    const freshClick = resolveRecordingCursorPlacement(
      source({ event: pointerEvent({ phase: "click", ageMs: 150 }) }),
    );
    const settledClick = resolveRecordingCursorPlacement(
      source({
        event: pointerEvent({ phase: "click", ageMs: BROWSER_RECORDING_CURSOR_PING_MS + 1 }),
      }),
    );
    const move = resolveRecordingCursorPlacement(source());
    expect(freshClick?.pingProgress).toBeCloseTo(0.25);
    expect(settledClick?.pingProgress).toBeNull();
    expect(move?.pingProgress).toBeNull();
  });

  it("returns null when the content presentation cannot be trusted", () => {
    expect(resolveRecordingCursorPlacement(source({ scale: 0 }))).toBeNull();
    expect(resolveRecordingCursorPlacement(source({ frameWidth: 0 }))).toBeNull();
  });
});

describe("resolveFrameDrawRect", () => {
  it("fits a matching-aspect frame edge to edge", () => {
    expect(resolveFrameDrawRect(800, 600, 1600, 1200)).toEqual({
      scale: 0.5,
      x: 0,
      y: 0,
      width: 800,
      height: 600,
    });
  });

  it("letterboxes a mismatched-aspect frame with centered bars", () => {
    const rect = resolveFrameDrawRect(800, 600, 1600, 900);
    expect(rect).toEqual({
      scale: 0.5,
      x: 0,
      y: 75,
      width: 800,
      height: 450,
    });
  });

  it("rejects frames without a usable size", () => {
    expect(resolveFrameDrawRect(800, 600, 0, 900)).toBeNull();
  });
});

describe("drawRecordingCursor", () => {
  const createContext = () => {
    const calls: string[] = [];
    const points: Array<readonly [number, number]> = [];
    let alpha = 1;
    return {
      calls,
      points,
      get globalAlpha() {
        return alpha;
      },
      set globalAlpha(value: number) {
        alpha = value;
        calls.push(`alpha:${value}`);
      },
      beginPath: () => calls.push("beginPath"),
      moveTo: (x: number, y: number) => {
        calls.push("moveTo");
        points.push([x, y]);
      },
      lineTo: (x: number, y: number) => {
        calls.push("lineTo");
        points.push([x, y]);
      },
      closePath: () => calls.push("closePath"),
      arc: () => calls.push("arc"),
      fill: () => calls.push("fill"),
      stroke: () => calls.push("stroke"),
      save: () => calls.push("save"),
      restore: () => calls.push("restore"),
    } as unknown as CanvasRenderingContext2D & {
      calls: string[];
      points: Array<readonly [number, number]>;
    };
  };

  it("places the arrow tip on the pointer position and restores the context", () => {
    const context = createContext();
    drawRecordingCursor(context, { x: 320, y: 480, size: 64, opacity: 1, pingProgress: null });
    expect(context.points[0]).toEqual([320, 480]);
    expect(context.calls.at(0)).toBe("save");
    expect(context.calls.at(-1)).toBe("restore");
  });
});
