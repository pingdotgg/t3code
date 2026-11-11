import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createPreviewMiniPlayerGesture } from "./previewMiniPlayerGesture";
import { resolvePreviewMiniPlayerFrame } from "./previewMiniPlayerLayout";

const container = { width: 1000, height: 800 };
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
  it("resizes from the rendered frame's ratio, not a source that disagrees or changes", () => {
    const frame = { x: 100.25, y: 80.75, width: 355, height: 222 };
    const { gesture, down, commit, style } = setup(frame);
    gesture.begin(down, "northwest");
    style.width = "460px";
    style.height = "288px";
    gesture.move(
      { ...down, clientX: down.clientX - 6, clientY: down.clientY + 53 },
      container,
      commit,
    );
    expect(commit).toHaveBeenLastCalledWith(
      { x: 120.25, y: 92.75, width: 335, height: 210 },
      "northwest",
    );
  });

  describe.each([null, "southeast"] as const)("a %s gesture", (direction) => {
    it.each(["pointerup", "pointercancel", "lostpointercapture", "blur", "buttons0"])(
      "ends on %s with a clamped position and ignores later movement",
      (termination) => {
        const { gesture, down, commit, target } = setup();
        gesture.begin(down, direction);
        gesture.move({ ...down, clientX: 700, clientY: 500 }, container, commit);
        const chosen = commit.mock.lastCall![0];
        const smaller = { width: 500, height: 400 };
        if (termination === "blur") gesture.finish(smaller, commit);
        else if (termination === "buttons0") gesture.move({ ...down, buttons: 0 }, smaller, commit);
        else gesture.end({ ...down, type: termination }, smaller, commit);
        const fitted = resolvePreviewMiniPlayerFrame({
          width: chosen.width,
          position: chosen,
          source: baseline,
          container: smaller,
        });
        expect(commit).toHaveBeenLastCalledWith({ ...chosen, x: fitted.x, y: fitted.y }, direction);
        expect(target.releasePointerCapture).toHaveBeenCalledWith(7);
        const calls = commit.mock.calls.length;
        gesture.move({ ...down, clientX: 900 }, container, commit);
        expect(commit).toHaveBeenCalledTimes(calls);
      },
    );
  });

  it("keeps the chosen resize width when the viewport shrinks before release", () => {
    const { gesture, down, commit } = setup();
    gesture.begin(down, "east");
    gesture.move({ ...down, clientX: down.clientX + 100 }, container, commit);
    const chosen = commit.mock.lastCall![0];
    gesture.end({ ...down, type: "pointerup" }, { width: 300, height: 300 }, commit);
    expect(commit.mock.lastCall![0].width).toBe(chosen.width);
  });

  it("discards a gesture whose handle lost capture before a new pointerdown", () => {
    const { gesture, down, commit, target } = setup();
    gesture.begin(down, "east");
    gesture.move({ ...down, clientX: 400 }, container, commit);
    commit.mockClear();
    target.hasPointerCapture.mockReturnValueOnce(false);
    const next = { ...down, pointerId: 8 };
    expect(gesture.begin(next, null)).toBe(true);
    gesture.move({ ...down, clientX: 500 }, container, commit);
    expect(commit).not.toHaveBeenCalled();
    gesture.move({ ...next, clientX: next.clientX + 10 }, container, commit);
    expect(commit).toHaveBeenCalledExactlyOnceWith({ ...baseline, x: baseline.x + 10 }, null);
  });

  it("reports a tap only for an unmoved, released touch on the move handle", () => {
    const { gesture, down, commit } = setup();
    const touch = { ...down, pointerType: "touch" };
    const tap = (event: typeof down, direction: "east" | null, type: string, dy = 2) => {
      gesture.begin(event, direction);
      gesture.move({ ...event, clientY: event.clientY + dy }, container, commit);
      return gesture.end({ ...event, type }, container, commit);
    };
    expect(tap(touch, null, "pointerup")).toBe(true);
    expect(tap(down, null, "pointerup")).toBe(false);
    expect(tap(touch, null, "pointerup", 20)).toBe(false);
    expect(tap(touch, null, "pointercancel")).toBe(false);
    expect(tap(touch, "east", "pointerup")).toBe(false);
  });
});
