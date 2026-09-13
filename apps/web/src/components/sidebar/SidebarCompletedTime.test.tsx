import { act, memo } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { SidebarCompletedTime } from "./SidebarCompletedTime";

let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-07T01:01:00Z"));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", {
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  });
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("advances visible and accessible completion times without rerendering its memoized row", async () => {
  const rowRender = vi.fn();
  const Row = memo(function Row() {
    rowRender();
    return <SidebarCompletedTime completedAt="2026-09-07T01:00:00Z" />;
  });
  await act(() => {
    renderer = create(<Row />);
  });
  expect(renderer!.root.findByType("time").props.dateTime).toBe("2026-09-07T01:00:00Z");
  expect(renderer!.root.findByProps({ className: "sr-only" }).children).toEqual(["Completed "]);
  expect(
    renderer!.root.findAll((node) => node.props.role === "status" || node.props["aria-live"]),
  ).toHaveLength(0);
  expect(renderer!.root.findByProps({ className: "text-secondary-label" }).children).toEqual([
    "1m",
  ]);

  await act(() => vi.advanceTimersByTime(60_000));

  expect(renderer!.root.findByProps({ className: "sr-only" }).children).toEqual(["Completed "]);
  expect(renderer!.root.findByProps({ className: "text-secondary-label" }).children).toEqual([
    "2m",
  ]);
  expect(rowRender).toHaveBeenCalledTimes(1);
  await act(() => renderer!.unmount());
  renderer = undefined;
  expect(vi.getTimerCount()).toBe(0);
});
