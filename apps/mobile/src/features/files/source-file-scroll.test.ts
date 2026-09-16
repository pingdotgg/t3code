import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { createSourceFileScrollRequest } from "./source-file-scroll";

const frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;

beforeEach(() => {
  frames.clear();
  nextFrame = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = ++nextFrame;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
});

afterEach(() => vi.unstubAllGlobals());

function runFrame() {
  const callbacks = [...frames.values()];
  frames.clear();
  for (const callback of callbacks) {
    callback(0);
  }
}

function createList() {
  type List = Parameters<typeof createSourceFileScrollRequest>[0];
  return {
    scrollToIndex: vi.fn<List["scrollToIndex"]>(),
    scrollToOffset: vi.fn<List["scrollToOffset"]>(),
  };
}

it("cancels the previous target's retry and ignores stale failures after a target change", () => {
  const list = createList();
  const previous = createSourceFileScrollRequest(list, 499);
  runFrame();
  previous.retry({ index: 499, averageItemLength: 20 }, 20);
  const staleCallbacks = [...frames.values()];

  previous.dispose();
  expect(frames.size).toBe(0);
  const current = createSourceFileScrollRequest(list, 99);
  current.retry({ index: 499, averageItemLength: 20 }, 20);
  runFrame();

  // A callback already dequeued by the scheduler must also be harmless.
  for (const callback of staleCallbacks) {
    callback(0);
  }
  previous.retry({ index: 499, averageItemLength: 20 }, 20);
  expect(list.scrollToIndex.mock.calls.map(([options]) => options.index)).toEqual([499, 99]);
  expect(list.scrollToOffset).toHaveBeenCalledExactlyOnceWith({ offset: 9980, animated: false });
  expect(frames.size).toBe(0);
  current.dispose();
});

it.each([false, true])("cancels pending work on disposal, including retries: %s", (retry) => {
  const list = createList();
  const request = createSourceFileScrollRequest(list, 100);
  if (retry) {
    runFrame();
    request.retry({ index: 100, averageItemLength: 0 }, 24);
    expect(list.scrollToOffset).toHaveBeenCalledWith({ offset: 2400, animated: false });
  }
  list.scrollToIndex.mockClear();

  request.dispose();
  expect(frames.size).toBe(0);
  runFrame();
  expect(list.scrollToIndex).not.toHaveBeenCalled();
});

it("limits retries to five per target and gives the next target a fresh budget", () => {
  const list = createList();
  const request = createSourceFileScrollRequest(list, 100);
  runFrame();
  for (let attempt = 0; attempt < 6; attempt += 1) {
    request.retry({ index: 100, averageItemLength: 20 }, 24);
    runFrame();
  }
  expect(list.scrollToIndex).toHaveBeenCalledTimes(6);
  expect(list.scrollToOffset).toHaveBeenCalledTimes(5);

  request.dispose();
  const next = createSourceFileScrollRequest(list, 200);
  runFrame();
  next.retry({ index: 200, averageItemLength: 20 }, 24);
  runFrame();
  expect(list.scrollToIndex).toHaveBeenLastCalledWith({
    index: 200,
    animated: false,
    viewPosition: 0.3,
  });
  expect(list.scrollToOffset).toHaveBeenCalledTimes(6);
  next.dispose();
});
