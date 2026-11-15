import { expect, it, vi } from "vite-plus/test";
import { createRenderScheduler } from "./renderScheduler.ts";

it("coalesces frame and pointer invalidations, then stops scheduling when idle or disposed", () => {
  const callbacks: FrameRequestCallback[] = [];
  const request = vi.fn((callback: FrameRequestCallback) => {
    callbacks.push(callback);
    return callbacks.length;
  });
  const cancel = vi.fn();
  const render = vi.fn();
  const scheduler = createRenderScheduler(render, request, cancel);
  scheduler.invalidate();
  scheduler.invalidate();
  expect(request).toHaveBeenCalledTimes(1);
  callbacks[0]?.(0);
  expect(render).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledTimes(1);
  scheduler.invalidate();
  scheduler.dispose();
  scheduler.dispose();
  scheduler.invalidate();
  callbacks[1]?.(0);
  expect(cancel).toHaveBeenCalledExactlyOnceWith(2);
  expect(render).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledTimes(2);
});
