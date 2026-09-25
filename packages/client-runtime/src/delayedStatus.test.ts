import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  createDelayedStatus,
  STATUS_MIN_VISIBLE_MS,
  STATUS_SHOW_DELAY_MS,
  type ShownStatus,
} from "./delayedStatus.ts";

function track() {
  const changes: Array<ShownStatus<string> | null> = [];
  const status = createDelayedStatus<string>((shown) => changes.push(shown));
  return { changes, status };
}

describe("createDelayedStatus", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("never shows a status that clears before the show delay", () => {
    const { changes, status } = track();
    status.update("a", "syncing");
    vi.advanceTimersByTime(STATUS_SHOW_DELAY_MS - 1);
    status.update("a", null);
    vi.runAllTimers();

    expect(changes).toEqual([]);
  });

  it("holds each shown status for the minimum time, then hides it at once", () => {
    const { changes, status } = track();
    status.update("a", "loading");
    vi.advanceTimersByTime(STATUS_SHOW_DELAY_MS);
    expect(changes).toEqual([{ key: "a", value: "loading" }]);

    // A new label gets its own full hold, even during the first label's hold.
    vi.advanceTimersByTime(1);
    status.update("a", "syncing");
    status.update("a", null);
    vi.advanceTimersByTime(STATUS_MIN_VISIBLE_MS - 1);
    expect(changes.at(-1)).toEqual({ key: "a", value: "syncing" });
    vi.advanceTimersByTime(1);
    expect(changes.at(-1)).toBeNull();

    status.update("a", "syncing");
    vi.advanceTimersByTime(STATUS_SHOW_DELAY_MS + STATUS_MIN_VISIBLE_MS);
    status.update("a", null);
    expect(changes.at(-1)).toBeNull();
  });

  it("drops the shown status at once when the key changes", () => {
    const { changes, status } = track();
    status.update("a", "syncing");
    vi.advanceTimersByTime(STATUS_SHOW_DELAY_MS);
    status.update("b", "syncing");
    expect(changes.at(-1)).toBeNull();

    vi.advanceTimersByTime(STATUS_SHOW_DELAY_MS);
    expect(changes.at(-1)).toEqual({ key: "b", value: "syncing" });
  });
});
