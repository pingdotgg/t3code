import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { UsageProviderChart } from "./UsageProviderChart";

const days = ["2026-09-01", "2026-09-02", "2026-09-03"];
let renderer: ReactTestRenderer;
const onZoomToDays = vi.fn();
const captures = new Set<number>();
const plot = {
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 300, height: 260 }),
  hasPointerCapture: (id: number) => captures.has(id),
  setPointerCapture: (id: number) => captures.add(id),
  releasePointerCapture: (id: number) => captures.delete(id),
};

function chart(windowDays: readonly string[], resolution: "day" | "hour" = "day") {
  return (
    <UsageProviderChart
      days={windowDays}
      daily={[]}
      hours={[]}
      hourly={[]}
      providers={[]}
      metric="cost"
      resolution={resolution}
      referenceTime={undefined}
      timeZone="UTC"
      onZoomToDays={onZoomToDays}
    />
  );
}

function pointer(name: "onPointerDown" | "onPointerUp", clientX: number) {
  renderer.root
    .find((node) => node.type === "div" && node.props.onPointerDown !== undefined)
    .props[name]({ button: 0, isPrimary: true, pointerId: 1, clientX, currentTarget: plot });
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  onZoomToDays.mockClear();
  captures.clear();
  await act(() => {
    renderer = create(chart(days), {
      createNodeMock: (element) => (element.type === "div" ? plot : null),
    });
  });
});

afterEach(async () => {
  await act(() => renderer.unmount());
  vi.unstubAllGlobals();
});

describe("usage chart brush ownership", () => {
  it("cancels a brush if date-field blur replaces its window before pointer-up", async () => {
    await act(() => pointer("onPointerDown", 0));
    expect(captures.has(1)).toBe(true);
    await act(() => renderer.update(chart(["2026-08-01", "2026-08-02", "2026-08-03"])));
    await act(() => pointer("onPointerUp", 300));
    expect(onZoomToDays).not.toHaveBeenCalled();
    expect(captures.has(1)).toBe(false);
  });

  it("keeps a brush when the same days are supplied by a fresh array", async () => {
    await act(() => pointer("onPointerDown", 0));
    await act(() => renderer.update(chart([...days])));
    await act(() => pointer("onPointerUp", 300));
    expect(onZoomToDays).toHaveBeenCalledExactlyOnceWith(days[0], days[2]);
  });

  it("cancels a brush when the view switches to hourly resolution", async () => {
    await act(() => pointer("onPointerDown", 0));
    await act(() => renderer.update(chart(days, "hour")));
    await act(() => pointer("onPointerUp", 300));
    expect(onZoomToDays).not.toHaveBeenCalled();
    expect(captures.has(1)).toBe(false);
  });
});
