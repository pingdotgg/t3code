import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createPreviewMiniPlayerGesture } from "./previewMiniPlayerGesture";
import { resizePreviewMiniPlayer, resolvePreviewMiniPlayerFrame } from "./previewMiniPlayerLayout";

const container = { width: 1000, height: 800 };
const baseline = { x: 100.25, y: 80.75, width: 355.5, height: 222.25 };

function setup(frame = baseline) {
  const preview = {};
  const style = {
    left: `${frame.x}px`,
    top: `${frame.y}px`,
    width: `${frame.width}px`,
    height: `${frame.height}px`,
  };
  const readStyle = vi.fn(() => style);
  vi.stubGlobal("getComputedStyle", readStyle);
  let captured = false;
  const target = {
    closest: vi.fn(() => preview as Element),
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
  return {
    gesture: createPreviewMiniPlayerGesture(),
    target,
    down,
    style,
    readStyle,
    preview,
    commit: vi.fn(),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("floating preview gestures", () => {
  it("leaves idle hover and unmatched end events inert", () => {
    const { gesture, down, commit, target, readStyle } = setup();
    gesture.move(down, container, commit);
    expect(gesture.end({ ...down, type: "pointerup" }, container, commit)).toBeNull();
    gesture.finish(container, commit);
    expect(commit).not.toHaveBeenCalled();
    expect(readStyle).not.toHaveBeenCalled();
    expect(target.releasePointerCapture).not.toHaveBeenCalled();
  });

  it("starts from its own fractional local CSS geometry and captures the handle", () => {
    const { gesture, down, commit, target, readStyle, preview } = setup();
    expect(gesture.begin(down, null)).toBe(true);
    expect(target.closest).toHaveBeenCalledWith("[data-preview-mini-player]");
    expect(readStyle).toHaveBeenCalledWith(preview);
    expect(target.setPointerCapture).toHaveBeenCalledWith(7);
    gesture.move(
      { ...down, clientX: down.clientX + 10.5, clientY: down.clientY + 8.25 },
      container,
      commit,
    );
    expect(commit).toHaveBeenLastCalledWith({ ...baseline, x: 110.75, y: 89 }, null);
  });

  it.each(["northwest", "northeast", "southwest", "southeast"] as const)(
    "%s keeps the rendered baseline ratio when the rounded frame disagrees with the source",
    (direction) => {
      const frame = { x: 100.25, y: 80.75, width: 355, height: 222 };
      const { gesture, down, commit, style, readStyle } = setup(frame);
      const source = { width: 1600, height: 1000 };
      expect(
        resolvePreviewMiniPlayerFrame({ width: 355, position: frame, source, container }),
      ).toEqual(frame);
      gesture.begin(down, direction);
      // A stream/source update can change layout mid-gesture; it must not change the baseline.
      style.width = "460px";
      style.height = "288px";
      const west = direction.includes("west");
      const north = direction.includes("north");
      gesture.move(
        {
          ...down,
          clientX: down.clientX + (west ? -6 : 6),
          clientY: down.clientY + (north ? 53 : -53),
        },
        container,
        commit,
      );
      const next = commit.mock.lastCall?.[0];
      expect(next).toEqual({
        x: west ? 120.25 : frame.x,
        y: north ? 92.75 : frame.y,
        width: 335,
        height: 210,
      });
      const usingLiveSource = resizePreviewMiniPlayer({
        start: frame,
        direction,
        delta: { x: west ? -6 : 6, y: north ? 53 : -53 },
        source,
        container,
      });
      expect(next?.width).not.toBe(usingLiveSource.width);
      expect(readStyle).toHaveBeenCalledTimes(1);
    },
  );

  describe.each([null, "southeast"] as const)("ending a %s gesture", (direction) => {
    it.each(["pointerup", "pointercancel", "lostpointercapture", "blur", "buttons0"])(
      "ends on %s, clamps position, and ignores later movement",
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
        expect(commit).toHaveBeenLastCalledWith(
          {
            ...chosen,
            x: fitted.x,
            y: fitted.y,
          },
          direction,
        );
        expect(target.releasePointerCapture).toHaveBeenCalledWith(7);
        const calls = commit.mock.calls.length;
        gesture.move({ ...down, clientX: 900 }, container, commit);
        gesture.finish(container, commit);
        expect(commit).toHaveBeenCalledTimes(calls);
      },
    );
  });

  it("preserves the chosen resize width when the viewport shrinks before release", () => {
    const { gesture, down, commit } = setup();
    gesture.begin(down, "east");
    gesture.move({ ...down, clientX: down.clientX + 100 }, container, commit);
    const chosen = commit.mock.lastCall?.[0];
    const smaller = { width: 300, height: 300 };
    gesture.end({ ...down, type: "pointerup" }, smaller, commit);
    const persisted = commit.mock.lastCall?.[0];
    expect(persisted?.width).toBe(chosen?.width);
    expect(commit.mock.lastCall?.[1]).toBe("east");
    expect(persisted?.x).toBe(12);
    const displayed = resolvePreviewMiniPlayerFrame({
      width: persisted!.width,
      position: persisted!,
      source: baseline,
      container: smaller,
    });
    expect(displayed.x).toBeGreaterThanOrEqual(12);
    expect(displayed.y).toBeGreaterThanOrEqual(12);
    expect(displayed.x + displayed.width).toBeLessThanOrEqual(smaller.width - 12);
    expect(displayed.y + displayed.height).toBeLessThanOrEqual(smaller.height - 12);
    expect(displayed.width).toBeLessThan(persisted!.width);

    expect(
      resolvePreviewMiniPlayerFrame({
        width: persisted!.width,
        position: persisted!,
        source: baseline,
        container,
      }).width,
    ).toBe(chosen?.width);
  });

  it("ignores other pointer IDs and a second pointerdown", () => {
    const { gesture, down, commit, target } = setup();
    gesture.begin(down, "east");
    expect(gesture.begin({ ...down, pointerId: 8 }, null)).toBe(false);
    gesture.move({ ...down, pointerId: 8, buttons: 0 }, container, commit);
    expect(
      gesture.end({ ...down, pointerId: 8, type: "pointercancel" }, container, commit),
    ).toBeNull();
    expect(target.releasePointerCapture).not.toHaveBeenCalled();
    gesture.move({ ...down, clientX: 400 }, container, commit);
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it("discards a gesture whose handle lost capture before a new pointerdown", () => {
    const { gesture, down, commit, target } = setup();
    expect(gesture.begin(down, "east")).toBe(true);
    gesture.move({ ...down, clientX: 400 }, container, commit);
    commit.mockClear();
    target.hasPointerCapture.mockReturnValueOnce(false);
    const next = { ...down, pointerId: 8 };
    expect(gesture.begin(next, null)).toBe(true);
    expect(commit).not.toHaveBeenCalled();
    expect(target.releasePointerCapture).not.toHaveBeenCalled();
    expect(target.setPointerCapture).toHaveBeenLastCalledWith(8);
    gesture.move({ ...down, clientX: 500 }, container, commit);
    expect(commit).not.toHaveBeenCalled();
    gesture.move({ ...next, clientX: next.clientX + 10 }, container, commit);
    expect(commit).toHaveBeenCalledExactlyOnceWith({ ...baseline, x: baseline.x + 10 }, null);
  });

  it.each(["mouse", "touch", "pen"])("supports %s drag and no-motion release", (pointerType) => {
    const { gesture, down, commit } = setup();
    const event = { ...down, pointerType };
    gesture.begin(event, null);
    gesture.move({ ...event, clientX: event.clientX + 2 }, container, commit);
    expect(gesture.end({ ...event, type: "pointerup" }, container, commit)).toBe(
      pointerType === "touch",
    );
    expect(commit).not.toHaveBeenCalled();
    gesture.begin(event, null);
    gesture.move({ ...event, clientY: event.clientY + 20 }, container, commit);
    expect(gesture.end({ ...event, type: "pointerup" }, container, commit)).toBe(false);
    expect(commit).toHaveBeenCalled();
  });

  it("does not treat cancelled touch gestures or resize handles as taps", () => {
    const { gesture, down, commit } = setup();
    const touch = { ...down, pointerType: "touch" };
    gesture.begin(touch, null);
    expect(gesture.end({ ...touch, type: "pointercancel" }, container, commit)).toBe(false);
    gesture.begin(touch, "east");
    expect(gesture.end({ ...touch, type: "pointerup" }, container, commit)).toBe(false);
  });

  it("abandons capture failure without creating an active gesture", () => {
    const { gesture, down, commit, target } = setup();
    target.setPointerCapture.mockImplementationOnce(() => {
      throw new Error("detached");
    });
    expect(gesture.begin(down, "east")).toBe(false);
    gesture.move({ ...down, clientX: 500 }, container, commit);
    gesture.finish(container, commit);
    expect(commit).not.toHaveBeenCalled();
    expect(target.releasePointerCapture).not.toHaveBeenCalled();
    expect(gesture.begin(down, "east")).toBe(true);
  });

  it("rejects secondary buttons and invalid element geometry", () => {
    const { gesture, down, style, readStyle } = setup();
    expect(gesture.begin({ ...down, button: 2 }, null)).toBe(false);
    expect(readStyle).not.toHaveBeenCalled();
    style.left = "auto";
    expect(gesture.begin(down, null)).toBe(false);
  });
});
