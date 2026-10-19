import type { PullRequestCheck } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { usePullRequestChecksRefresh } from "./usePullRequestChecksRefresh";

let root: Root;
let visibility: DocumentVisibilityState;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  root = createRoot(document.createElement("div"));
});

afterEach(() => {
  act(() => root.unmount());
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.each(["pending", "action-required"] as const)(
  "polls quiet PRs each minute, speeds up for %s or missing checks, resumes from idle, and stops for closed PRs",
  (pendingStatus) => {
    const refresh = vi.fn();
    function Probe({
      status = "success",
      enabled = true,
    }: {
      status?: PullRequestCheck["status"] | null;
      enabled?: boolean;
    }) {
      usePullRequestChecksRefresh({
        refresh,
        enabled,
        key: `test-pr-checks:${pendingStatus}`,
        checks: status === null ? [] : [{ name: "CI", status, description: null, url: null }],
      });
      return null;
    }
    const update = (props: Parameters<typeof Probe>[0]) =>
      act(() => root.render(<Probe {...props} />));
    const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));

    update({});
    advance(59_999);
    expect(refresh).toHaveBeenCalledTimes(0);
    advance(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    update({ status: pendingStatus });
    advance(44_999);
    expect(refresh).toHaveBeenCalledTimes(1);
    advance(1);
    expect(refresh).toHaveBeenCalledTimes(2);
    update({ status: "failure" });
    advance(60_000);
    expect(refresh).toHaveBeenCalledTimes(3);
    update({ status: null });
    for (let tick = 0; tick < 3; tick++) {
      advance(45_000);
      update({ status: null });
    }
    expect(refresh).toHaveBeenCalledTimes(6);
    advance(44_999);
    expect(refresh).toHaveBeenCalledTimes(6);
    advance(1);
    expect(refresh).toHaveBeenCalledTimes(7);
    advance(6 * 60_000);
    const beforeResume = refresh.mock.calls.length;
    act(() => document.dispatchEvent(new Event("pointerdown")));
    expect(refresh).toHaveBeenCalledTimes(beforeResume + 1);
    visibility = "hidden";
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    advance(60_000);
    expect(refresh).toHaveBeenCalledTimes(beforeResume + 1);
    visibility = "visible";
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(refresh).toHaveBeenCalledTimes(beforeResume + 2);
    update({ enabled: false });
    advance(120_000);
    expect(refresh).toHaveBeenCalledTimes(beforeResume + 2);
  },
);
