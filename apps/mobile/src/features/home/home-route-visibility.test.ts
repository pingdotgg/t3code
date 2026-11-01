import { describe, expect, it, vi } from "vite-plus/test";

import {
  recordHomeTransitionEnd,
  recordHomeTransitionStart,
  runWhenHomeCovered,
} from "./home-route-visibility";

vi.mock("@react-navigation/native", () => ({ useNavigation: vi.fn() }));

describe("runWhenHomeCovered", () => {
  it("waits for the page opening over Home to finish covering it, then runs once", () => {
    const clearSearch = vi.fn();
    runWhenHomeCovered(clearSearch);
    recordHomeTransitionStart(true);
    expect(clearSearch).not.toHaveBeenCalled();
    recordHomeTransitionEnd(true);
    expect(clearSearch).toHaveBeenCalledTimes(1);
    recordHomeTransitionStart(false);
    recordHomeTransitionEnd(true);
    expect(clearSearch).toHaveBeenCalledTimes(1);
  });

  it("drops the action when Home reappears before it is covered", () => {
    const clearSearch = vi.fn();
    runWhenHomeCovered(clearSearch);
    recordHomeTransitionStart(true);
    recordHomeTransitionStart(false);
    recordHomeTransitionEnd(false);
    recordHomeTransitionEnd(true);
    expect(clearSearch).not.toHaveBeenCalled();
  });
});
