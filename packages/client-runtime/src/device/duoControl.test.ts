import { afterEach, expect, it, vi } from "vite-plus/test";
import { createDuoControl, type DuoCommand } from "./duoControl.ts";
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

it("coalesces slider edits behind acknowledgements and lets a preset replace queued edits", () => {
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
