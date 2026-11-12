import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

import { useThreadListNow } from "./use-thread-list-now";

const MINUTE_MS = Date.UTC(2026, 9, 27, 12, 0);
const iso = (secondsIntoMinute: number) =>
  new Date(MINUTE_MS + secondsIntoMinute * 1000).toISOString();

it("wakes for each snooze that expires within the same minute", async () => {
  using _timers = { [Symbol.dispose]: () => vi.useRealTimers() };
  vi.useFakeTimers({ now: MINUTE_MS + 10_000 });
  const threads = [{ snoozedUntil: iso(30) }, { snoozedUntil: iso(40) }];
  const seen: string[] = [];
  function Probe() {
    const now = useThreadListNow(threads);
    useLayoutEffect(() => {
      seen.push(now);
    });
    return null;
  }

  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Probe />));
  await act(async () => vi.advanceTimersByTime(20_000));
  expect(seen.at(-1)).toBe(iso(30));

  await act(async () => vi.advanceTimersByTime(10_000));
  expect(seen.at(-1)).toBe(iso(40));
  act(() => root.unmount());
});
