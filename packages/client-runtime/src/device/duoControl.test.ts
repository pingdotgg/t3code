import { afterEach, expect, it, vi } from "vite-plus/test";
import { createDuoControl, createDuoPinch, type DuoCommand } from "./duoControl.ts";
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
