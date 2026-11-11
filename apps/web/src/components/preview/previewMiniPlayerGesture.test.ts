import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createPreviewMiniPlayerGesture } from "./previewMiniPlayerGesture";
import { resolvePreviewMiniPlayerFrame } from "./previewMiniPlayerLayout";

const source = { width: 1600, height: 1000 };
const space = { container: { width: 1000, height: 800 }, source };
const baseline = { x: 100.25, y: 80.75, width: 355.5, height: 222.25 };

function setup(frame = baseline) {
  const style = {
    left: `${frame.x}px`,
    top: `${frame.y}px`,
    width: `${frame.width}px`,
    height: `${frame.height}px`,
  };
  vi.stubGlobal("getComputedStyle", () => style);
  let captured = false;
  const target = {
    closest: () => ({}) as Element,
    setPointerCapture: vi.fn(() => {
      captured = true;
    }),
    hasPointerCapture: vi.fn(() => captured),
    releasePointerCapture: vi.fn(() => {
      captured = false;
    }),
  };
  const down = {
    button: 0,
    buttons: 1,
    pointerId: 7,
    pointerType: "mouse",
    clientX: 300.5,
    clientY: 200.25,
    currentTarget: target,
  };
  return { gesture: createPreviewMiniPlayerGesture(), target, down, style, commit: vi.fn() };
}

afterEach(() => vi.unstubAllGlobals());

describe("floating preview gestures", () => {
  it.each([0, 40])(
    "keeps the anchored edges where they were when the source ratio changes mid-resize (pre-move %d px)",
    (premove) => {
      const frame = { x: 996, y: 433, width: 268, height: 179 };
      const { gesture, down, commit } = setup(frame);
      const container = { width: 1440, height: 900 };
      gesture.begin(down, "northwest", { width: 1200, height: 800 });
      const pointer = { ...down, clientX: down.clientX - premove, clientY: down.clientY - premove };
      gesture.move(pointer, { container, source: { width: 1200, height: 800 } }, commit);
      const live = { container, source: { width: 1200, height: 1000 } };
      gesture.move(pointer, live, commit);
      gesture.end({ ...down, type: "pointerup" }, live, commit);
      const [persisted] = commit.mock.lastCall!;
      const rendered = resolvePreviewMiniPlayerFrame({
        width: persisted.width,
        position: persisted,
        ...live,
      });
      expect(rendered.height / rendered.width).toBeCloseTo(1000 / 1200, 2);
      expect(rendered.x + rendered.width).toBeCloseTo(frame.x + frame.width, 0);
      expect(rendered.y + rendered.height).toBeCloseTo(frame.y + frame.height, 0);
    },
  );

  describe.each([null, "southeast"] as const)("a %s gesture", (direction) => {
    it.each(["pointerup", "pointercancel", "lostpointercapture", "blur", "buttons0"])(
      "ends on %s with a clamped position and ignores later movement",
      (termination) => {
        const { gesture, down, commit, target } = setup();
        gesture.begin(down, direction, source);
        gesture.move({ ...down, clientX: 700, clientY: 500 }, space, commit);
        const chosen = commit.mock.lastCall![0];
        const smaller = { container: { width: 500, height: 400 }, source };
        if (termination === "blur") gesture.finish(smaller, commit);
        else if (termination === "buttons0") gesture.move({ ...down, buttons: 0 }, smaller, commit);
        else gesture.end({ ...down, type: termination }, smaller, commit);
        const fitted = resolvePreviewMiniPlayerFrame({
          width: chosen.width,
          position: chosen,
          ...smaller,
        });
        expect(commit).toHaveBeenLastCalledWith({ ...chosen, x: fitted.x, y: fitted.y }, direction);
        expect(target.releasePointerCapture).toHaveBeenCalledWith(7);
        const calls = commit.mock.calls.length;
        gesture.move({ ...down, clientX: 900 }, space, commit);
        expect(commit).toHaveBeenCalledTimes(calls);
      },
    );
  });

  it("keeps the chosen resize width when the viewport shrinks before release", () => {
    const { gesture, down, commit } = setup();
    gesture.begin(down, "east", source);
    gesture.move({ ...down, clientX: down.clientX + 100 }, space, commit);
    const chosen = commit.mock.lastCall![0];
    gesture.end(
      { ...down, type: "pointerup" },
      { container: { width: 300, height: 300 }, source },
      commit,
    );
    expect(commit.mock.lastCall![0].width).toBe(chosen.width);
  });

  it("discards a gesture whose handle lost capture before a new pointerdown", () => {
    const { gesture, down, commit, target } = setup();
    gesture.begin(down, "east", source);
    gesture.move({ ...down, clientX: 400 }, space, commit);
    commit.mockClear();
    target.hasPointerCapture.mockReturnValueOnce(false);
    const next = { ...down, pointerId: 8 };
    expect(gesture.begin(next, null, source)).toBe(true);
    gesture.move({ ...down, clientX: 500 }, space, commit);
    expect(commit).not.toHaveBeenCalled();
    gesture.move({ ...next, clientX: next.clientX + 10 }, space, commit);
    expect(commit).toHaveBeenCalledExactlyOnceWith({ ...baseline, x: baseline.x + 10 }, null);
  });

  it("reports a tap only for an unmoved, released touch on the move handle", () => {
    const { gesture, down, commit } = setup();
    const touch = { ...down, pointerType: "touch" };
    const tap = (event: typeof down, direction: "east" | null, type: string, dy = 2) => {
      gesture.begin(event, direction, source);
      gesture.move({ ...event, clientY: event.clientY + dy }, space, commit);
      return gesture.end({ ...event, type }, space, commit);
    };
    expect(tap(touch, null, "pointerup")).toBe(true);
    expect(tap(down, null, "pointerup")).toBe(false);
    expect(tap(touch, null, "pointerup", 20)).toBe(false);
    expect(tap(touch, null, "pointercancel")).toBe(false);
    expect(tap(touch, "east", "pointerup")).toBe(false);
  });
});
