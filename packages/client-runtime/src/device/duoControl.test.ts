import { afterEach, expect, it, vi } from "vite-plus/test";
import {
  createDuoControl,
  createDuoPinch,
  duoFoldState,
  duoHoldOrientation,
  type DuoCommand,
} from "./duoControl.ts";
afterEach(() => vi.useRealTimers());

it("keeps a failed send visible, including a disconnect while draining queued motion", () => {
  const send = vi.fn((_request: { requestId: number; command: DuoCommand }) => false);
  const onChange = vi.fn();
  const queue = createDuoControl({ send, onChange });
  queue.enqueue({ control: "angle", value: 40 });
  expect(onChange).toHaveBeenLastCalledWith({
    pending: false,
    requested: null,
    error: "Device is disconnected.",
  });
  send.mockReturnValueOnce(true);
  queue.enqueue({ control: "pose", value: "book" });
  queue.enqueue({ control: "angle", value: 60 });
  queue.receive({ requestId: 2, ok: true });
  expect(onChange).toHaveBeenLastCalledWith({
    pending: false,
    requested: null,
    error: "Device is disconnected.",
  });
});

it("coalesces hinge edits behind acknowledgements and lets a preset replace queued edits", () => {
  const send = vi.fn((_request: { requestId: number; command: DuoCommand }) => true);
  const onChange = vi.fn();
  const queue = createDuoControl({ send, onChange });
  queue.enqueue({ control: "angle", value: 40 });
  queue.enqueue({ control: "angle", value: 50 });
  queue.enqueue({ control: "angle", value: 60 });
  expect(send).toHaveBeenCalledTimes(1);
  queue.receive({ requestId: 1, ok: true });
  expect(send.mock.calls[1]?.[0]).toEqual({
    requestId: 2,
    command: { control: "angle", value: 60 },
  });
  queue.enqueue({ control: "angle", value: 100 });
  queue.enqueue({ control: "pose", value: "tent" });
  queue.receive({ requestId: 2, ok: true });
  expect(send.mock.calls[2]?.[0]).toEqual({
    requestId: 3,
    command: { control: "pose", value: "tent" },
  });
  queue.receive({ requestId: 3, ok: true });
  expect(onChange).toHaveBeenLastCalledWith({ pending: false, requested: null, error: null });
  queue.clear();
});

it("drops queued commands on failure, timeout and disconnect; late replies cannot acknowledge later work", () => {
  vi.useFakeTimers();
  const send = vi.fn((_request: { requestId: number; command: DuoCommand }) => true);
  const onChange = vi.fn();
  const queue = createDuoControl({ send, onChange, timeoutMs: 100 });
  queue.enqueue({ control: "angle", value: 90 });
  queue.enqueue({ control: "angle", value: 100 });
  vi.advanceTimersByTime(100);
  expect(onChange.mock.lastCall?.[0].error).toContain("timed out");
  queue.enqueue({ control: "pose", value: "open" });
  queue.receive({ requestId: 1, ok: true });
  expect(onChange.mock.lastCall?.[0].pending).toBe(true);
  queue.enqueue({ control: "angle", value: 130 });
  queue.receive({ requestId: 2, ok: false, error: "native refused" });
  expect(onChange.mock.lastCall?.[0]).toEqual({
    pending: false,
    requested: null,
    error: "native refused",
  });
  queue.enqueue({ control: "pose", value: "book" });
  queue.enqueue({ control: "pose", value: "closed" });
  queue.clear();
  queue.receive({ requestId: 3, ok: true });
  expect(send).toHaveBeenCalledTimes(3);
  queue.enqueue({ control: "angle", value: Infinity });
  expect(send).toHaveBeenCalledTimes(3);
  queue.clear();
});

it("pinches only a hit device, accumulates independently of native readback, clamps and cancels", () => {
  let confirmed = 90;
  const change = vi.fn();
  const pinch = createDuoPinch({
    angle: () => confirmed,
    contains: (x, y) => x > 0.2 && y > 0.2,
    change,
  });
  expect(pinch.begin(0.1, 0.5)).toBe(false);
  pinch.move(1);
  expect(change).not.toHaveBeenCalled();
  expect(pinch.begin(0.5, 0.5)).toBe(true);
  pinch.move(0.25);
  expect(change).toHaveBeenLastCalledWith(120);
  confirmed = 100;
  pinch.move(0.25);
  expect(change).toHaveBeenLastCalledWith(150);
  pinch.move(2);
  expect(change).toHaveBeenLastCalledWith(180);
  pinch.move(-3);
  expect(change).toHaveBeenLastCalledWith(0);
  pinch.move(NaN);
  pinch.end();
  expect(change).toHaveBeenLastCalledWith(null);
  const count = change.mock.calls.length;
  pinch.move(1);
  pinch.end();
  expect(change).toHaveBeenCalledTimes(count);
  expect(pinch.active).toBe(false);
});

// Screen configs as an iPhone Duo simulator reports them for each way of holding the device.
it.each([
  [
    "vertical phone, closed",
    { screenId: 1, orientation: "portrait", hingeAngle: 0 },
    "closed",
    true,
  ],
  [
    "horizontal phone, closed",
    { screenId: 1, orientation: "landscape_right", hingeAngle: 0 },
    "closed",
    false,
  ],
  [
    "vertical phone opened as a book",
    { screenId: 3, orientation: "landscape_left", hingeAngle: 180 },
    "open",
    true,
  ],
  [
    "horizontal phone opened as a laptop",
    { screenId: 3, orientation: "portrait_upside_down", hingeAngle: 180 },
    "open",
    false,
  ],
  ["half-open book", { screenId: 3, orientation: "landscape_left", hingeAngle: 90 }, "half", true],
] as const)("reads a %s", (_name, screen, fold, phoneVertical) => {
  expect(duoFoldState(screen)).toEqual({ fold, stand: false, phoneVertical, settled: true });
});

it("marks a display handoff unsettled while the cover reports the inner display's orientation", () => {
  // Recorded from the iPhone Duo simulator opening a closed vertical phone to a book.
  const handoff = [
    { screenId: 1, orientation: "portrait", hingeAngle: 90 },
    { screenId: 1, orientation: "landscape_left", hingeAngle: 90 },
    { screenId: 3, orientation: "landscape_left", hingeAngle: 90 },
  ] as const;
  expect(handoff.map((screen) => duoFoldState(screen).settled)).toEqual([false, false, true]);
  // Closing hands back to the cover the same way.
  expect(duoFoldState({ screenId: 3, orientation: "landscape_left", hingeAngle: 0 }).settled).toBe(
    false,
  );
});

it("marks native stands so the fold group does not also claim them", () => {
  expect(
    duoFoldState({ screenId: 3, orientation: "portrait", hingeAngle: 90, hingePose: "laptop" }),
  ).toEqual({ fold: "half", stand: true, phoneVertical: false, settled: true });
});

it("falls back like the 3D view when hinge fields are missing", () => {
  expect(duoFoldState({ screenId: 1, orientation: "portrait" })).toMatchObject({
    fold: "closed",
    phoneVertical: true,
  });
  // Without a display ID the 3D view draws the open inner panel, so the controls do too.
  expect(duoFoldState({ orientation: "landscape_left" })).toMatchObject({
    fold: "open",
    phoneVertical: true,
  });
});

it("rotates a stand back to how the phone was held, in the frame of the display receiving it", () => {
  // Recorded from the iPhone Duo simulator: Tent can rest on either display.
  // Rotating the inner display to landscape_left, or the cover to portrait,
  // leaves a phone that opens and closes vertical.
  expect(duoHoldOrientation(true, 3)).toBe("landscape_left");
  expect(duoHoldOrientation(true, 1)).toBe("portrait");
  // A quarter turn apart, these describe the same horizontal phone.
  expect(duoHoldOrientation(false, 1)).toBe("landscape_left");
  expect(duoHoldOrientation(false, 3)).toBe("portrait_upside_down");
  for (const screenId of [1, 3])
    for (const vertical of [true, false])
      expect(
        duoFoldState({ screenId, orientation: duoHoldOrientation(vertical, screenId) })
          .phoneVertical,
      ).toBe(vertical);
});
