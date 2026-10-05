import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createTimelineEndAffordance } from "./timelineEndAffordance";

afterEach(() => vi.useRealTimers());

describe("timeline end recovery", () => {
  it("shows recovery after sustained distance, even during continuous streaming reports", () => {
    vi.useFakeTimers();
    const setVisible = vi.fn();
    const affordance = createTimelineEndAffordance(setVisible);
    for (let i = 0; i < 10; i++) {
      affordance.report(false);
      vi.advanceTimersByTime(20);
    }
    expect(setVisible).toHaveBeenCalledWith(true);
    affordance.cancel();
  });
  it("does not flash during brief layout settling", () => {
    vi.useFakeTimers();
    const setVisible = vi.fn();
    const affordance = createTimelineEndAffordance(setVisible);
    affordance.report(false);
    vi.advanceTimersByTime(100);
    affordance.report(true);
    vi.advanceTimersByTime(200);
    expect(setVisible).toHaveBeenCalledExactlyOnceWith(false);
  });
  it("hides immediately on reaching the end and can show again", () => {
    vi.useFakeTimers();
    const setVisible = vi.fn();
    const affordance = createTimelineEndAffordance(setVisible);
    affordance.report(false);
    vi.advanceTimersByTime(150);
    expect(setVisible).toHaveBeenLastCalledWith(true);
    affordance.report(true);
    expect(setVisible).toHaveBeenLastCalledWith(false);
    affordance.report(false);
    vi.advanceTimersByTime(150);
    expect(setVisible).toHaveBeenLastCalledWith(true);
  });
  it("cancels pending recovery on navigation or an explicit return to the end", () => {
    vi.useFakeTimers();
    const setVisible = vi.fn();
    const affordance = createTimelineEndAffordance(setVisible);
    affordance.report(false);
    affordance.cancel();
    vi.advanceTimersByTime(200);
    expect(setVisible).not.toHaveBeenCalled();
  });
});
