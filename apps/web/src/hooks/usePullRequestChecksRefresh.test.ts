import type { PullRequestCheck } from "@t3tools/contracts";
import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { expect, it, vi } from "vite-plus/test";

import { usePullRequestChecksRefresh } from "./usePullRequestChecksRefresh";

it("polls quiet PRs each minute, speeds up for runs and pushes, resumes from idle, and stops for closed PRs", () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  const document = Object.assign(new EventTarget(), { visibilityState: "visible" });
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const refresh = vi.fn();
  let updatedAt = Date.now();
  let renderer: ReactTestRenderer | undefined;
  function Probe({
    status = "success",
    headSha = "one",
    enabled = true,
    busy = false,
  }: {
    status?: PullRequestCheck["status"] | null;
    headSha?: string;
    enabled?: boolean;
    busy?: boolean;
  }) {
    usePullRequestChecksRefresh({
      refresh: busy ? null : refresh,
      enabled,
      key: "test-pr-checks",
      headSha,
      updatedAt,
      checks: status === null ? [] : [{ name: "CI", status, description: null, url: null }],
    });
    return null;
  }
  const update = (props: Parameters<typeof Probe>[0]) => {
    updatedAt = Date.now();
    act(() => renderer?.update(createElement(Probe, props)));
  };
  const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));
  try {
    act(() => {
      renderer = create(createElement(Probe));
    });
    advance(59_999);
    expect(refresh).toHaveBeenCalledTimes(0);
    advance(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    update({ status: "pending" });
    advance(44_999);
    expect(refresh).toHaveBeenCalledTimes(1);
    advance(1);
    expect(refresh).toHaveBeenCalledTimes(2);
    update({ status: "failure" });
    advance(60_000);
    expect(refresh).toHaveBeenCalledTimes(3);
    update({ headSha: "two", status: null });
    for (let tick = 0; tick < 3; tick++) {
      advance(45_000);
      update({ headSha: "two", status: null });
    }
    expect(refresh).toHaveBeenCalledTimes(6);
    advance(59_999);
    expect(refresh).toHaveBeenCalledTimes(6);
    advance(1);
    expect(refresh).toHaveBeenCalledTimes(7);
    advance(6 * 60_000);
    const beforeResume = refresh.mock.calls.length;
    act(() => document.dispatchEvent(new Event("pointerdown")));
    expect(refresh).toHaveBeenCalledTimes(beforeResume + 1);
    document.visibilityState = "hidden";
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    advance(60_000);
    expect(refresh).toHaveBeenCalledTimes(beforeResume + 1);
    document.visibilityState = "visible";
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(refresh).toHaveBeenCalledTimes(beforeResume + 2);
    update({ enabled: false });
    advance(120_000);
    expect(refresh).toHaveBeenCalledTimes(beforeResume + 2);
  } finally {
    act(() => renderer?.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
