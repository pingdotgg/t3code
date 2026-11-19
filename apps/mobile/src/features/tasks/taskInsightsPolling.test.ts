import { expect, it, vi } from "vite-plus/test";

import { pollWhileActive } from "./taskInsightsPolling";

it("reads only while the app is active, and once more when it comes back", () => {
  using _timers = { [Symbol.dispose]: () => vi.useRealTimers() };
  vi.useFakeTimers();
  let active = true;
  let comeBack = () => {};
  const read = vi.fn();
  const stop = pollWhileActive({
    read,
    intervalMs: 1_000,
    app: {
      isActive: () => active,
      onActive: (listener) => {
        comeBack = listener;
        return () => {
          comeBack = () => {};
        };
      },
    },
  });
  expect(read).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(1_000);
  expect(read).toHaveBeenCalledTimes(2);

  active = false;
  vi.advanceTimersByTime(3_000);
  expect(read).toHaveBeenCalledTimes(2);

  active = true;
  comeBack();
  expect(read).toHaveBeenCalledTimes(3);

  stop();
  comeBack();
  vi.advanceTimersByTime(3_000);
  expect(read).toHaveBeenCalledTimes(3);
});
