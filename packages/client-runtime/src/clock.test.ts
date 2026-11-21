import { EnvironmentId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { deadlineStore, recordServerClock, secondTick, toServerClock } from "./clock.ts";

describe("deadlineStore", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("flips once at the deadline and notifies every subscriber from one timer", () => {
    vi.useFakeTimers({ now: 10_000 });
    const store = deadlineStore(10_500);
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribeFirst = store.subscribe(first);
    const unsubscribeSecond = deadlineStore(10_500).subscribe(second);
    expect(vi.getTimerCount()).toBe(1);
    expect(store.getSnapshot()).toBe(false);

    vi.advanceTimersByTime(499);
    expect(store.getSnapshot()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(store.getSnapshot()).toBe(true);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    unsubscribeFirst();
    unsubscribeSecond();
  });

  it("shares one timer between callers that obtain the deadline before subscribing", () => {
    vi.useFakeTimers({ now: 0 });
    const first = deadlineStore(2_000);
    const second = deadlineStore(2_000);
    const firstListener = vi.fn();
    const secondListener = vi.fn();
    const unsubscribeFirst = first.subscribe(firstListener);
    const unsubscribeSecond = second.subscribe(secondListener);
    expect(vi.getTimerCount()).toBe(1);

    // A click observing the passed deadline must update every subscriber.
    vi.setSystemTime(5_000);
    first.refresh();
    expect(second.getSnapshot()).toBe(true);
    expect(secondListener).toHaveBeenCalledTimes(1);
    expect(firstListener).toHaveBeenCalledTimes(1);
    unsubscribeFirst();
    unsubscribeSecond();
  });

  it("re-arms deadlines beyond the 32-bit timer range instead of firing early", () => {
    vi.useFakeTimers({ now: 0 });
    const deadline = 2_147_483_647 + 1_000;
    const store = deadlineStore(deadline);
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    vi.advanceTimersByTime(2_147_483_647);
    expect(store.getSnapshot()).toBe(false);
    expect(listener).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(store.getSnapshot()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("refresh catches up when the timer runs late", () => {
    vi.useFakeTimers({ now: 0 });
    const store = deadlineStore(2_000);
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.refresh();
    expect(listener).not.toHaveBeenCalled();
    // Wall clock jumps past the deadline without the timer firing (sleep, throttling).
    vi.setSystemTime(5_000);
    expect(store.getSnapshot()).toBe(false);
    store.refresh();
    expect(store.getSnapshot()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    unsubscribe();
  });

  it("stops its timer when the last subscriber leaves", () => {
    vi.useFakeTimers({ now: 0 });
    const store = deadlineStore(1_000);
    const unsubscribe = store.subscribe(vi.fn());
    unsubscribe();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(1_000);
    expect(store.getSnapshot()).toBe(true);
  });

  it("treats a missing or unparseable deadline as never passing", () => {
    vi.useFakeTimers({ now: 0 });
    expect(deadlineStore(null).getSnapshot()).toBe(false);
    const store = deadlineStore(Number.NaN);
    store.subscribe(vi.fn());
    expect(vi.getTimerCount()).toBe(0);
    expect(store.getSnapshot()).toBe(false);
  });
});

describe("secondTick", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("advances on wall-clock second boundaries", () => {
    vi.useFakeTimers({ now: 5_250 });
    const listener = vi.fn();
    const unsubscribe = secondTick.subscribe(listener);
    expect(secondTick.getSnapshot()).toBe(5_000);
    vi.advanceTimersByTime(749);
    expect(listener).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(secondTick.getSnapshot()).toBe(6_000);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops ticking when the last subscriber leaves during a tick", () => {
    vi.useFakeTimers({ now: 0 });
    const unsubscribe = secondTick.subscribe(() => unsubscribe());
    vi.advanceTimersByTime(1_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps one timer when a subscriber replaces itself during a tick", () => {
    vi.useFakeTimers({ now: 0 });
    let unsubscribeNext = () => {};
    const unsubscribe = secondTick.subscribe(() => {
      unsubscribe();
      unsubscribeNext = secondTick.subscribe(() => {});
    });
    vi.advanceTimersByTime(1_000);
    expect(vi.getTimerCount()).toBe(1);
    unsubscribeNext();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("server clock", () => {
  const HOUR = 3_600_000;

  it("counts from a host clock running ahead, minus only the reply's latency", () => {
    const environmentId = EnvironmentId.make("ahead");
    recordServerClock(environmentId, {
      serverTimeMs: HOUR + 1_000,
      requestedAtMs: 900,
      receivedAtMs: 1_050,
    });
    expect(toServerClock(environmentId, 2_050)).toBe(HOUR + 2_000);
  });

  it("counts from a host clock running behind, minus only the request's latency", () => {
    const environmentId = EnvironmentId.make("behind");
    recordServerClock(environmentId, {
      serverTimeMs: 1_000,
      requestedAtMs: HOUR + 900,
      receivedAtMs: HOUR + 1_050,
    });
    expect(toServerClock(environmentId, HOUR + 1_900)).toBe(2_000);
  });

  it("leaves clocks that agree within the round trip unshifted", () => {
    const environmentId = EnvironmentId.make("synced");
    recordServerClock(environmentId, {
      serverTimeMs: 5_000,
      requestedAtMs: 1_000,
      receivedAtMs: 9_000,
    });
    expect(toServerClock(environmentId, 12_345)).toBe(12_345);
  });
});
