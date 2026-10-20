import type { PullRequestCheck } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { act, fakeTimers, render } from "../../test/render";
import { usePullRequestChecksRefresh } from "./usePullRequestChecksRefresh";

it.each(["pending", "action-required"] as const)(
  "polls quiet PRs each minute, speeds up for %s or missing checks, resumes from idle, and stops for closed PRs",
  async (pendingStatus) => {
    using _timers = fakeTimers();
    vi.setSystemTime(1_000_000);
    let visibility: DocumentVisibilityState = "visible";
    using _visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockImplementation(() => visibility);
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
    await using screen = await render(<Probe />);
    const update = (props: Parameters<typeof Probe>[0]) => screen.rerender(<Probe {...props} />);
    const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));

    await advance(59_999);
    expect(refresh).toHaveBeenCalledTimes(0);
    await advance(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    await update({ status: pendingStatus });
    await advance(44_999);
    expect(refresh).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(refresh).toHaveBeenCalledTimes(2);
    await update({ status: "failure" });
    await advance(60_000);
    expect(refresh).toHaveBeenCalledTimes(3);
    await update({ status: null });
    for (let tick = 0; tick < 3; tick++) {
      await advance(45_000);
      await update({ status: null });
    }
    expect(refresh).toHaveBeenCalledTimes(6);
    await advance(44_999);
    expect(refresh).toHaveBeenCalledTimes(6);
    await advance(1);
    expect(refresh).toHaveBeenCalledTimes(7);
    await advance(6 * 60_000);
    const beforeResume = refresh.mock.calls.length;
    await act(() => document.dispatchEvent(new Event("pointerdown")));
    expect(refresh).toHaveBeenCalledTimes(beforeResume + 1);
    visibility = "hidden";
    await act(() => document.dispatchEvent(new Event("visibilitychange")));
    await advance(60_000);
    expect(refresh).toHaveBeenCalledTimes(beforeResume + 1);
    visibility = "visible";
    await act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(refresh).toHaveBeenCalledTimes(beforeResume + 2);
    await update({ enabled: false });
    await advance(120_000);
    expect(refresh).toHaveBeenCalledTimes(beforeResume + 2);
  },
);
