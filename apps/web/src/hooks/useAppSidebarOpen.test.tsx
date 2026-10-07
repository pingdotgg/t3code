import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useAppSidebarOpen } from "./useAppSidebarOpen";

let renderer: ReactTestRenderer | null = null;
let sidebar: ReturnType<typeof useAppSidebarOpen>;
let committedOpen: boolean[];

function Probe({ isOnSettings }: { isOnSettings: boolean }) {
  const result = useAppSidebarOpen(isOnSettings);
  useLayoutEffect(() => {
    sidebar = result;
    committedOpen.push(result.open);
  });
  return null;
}

async function navigate(isOnSettings: boolean) {
  committedOpen = [];
  await act(() => {
    if (renderer) renderer.update(<Probe isOnSettings={isOnSettings} />);
    else renderer = create(<Probe isOnSettings={isOnSettings} />);
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = null;
  vi.unstubAllGlobals();
});

describe("app sidebar navigation", () => {
  it("reveals Settings on the first commit after leaving collapsed chat", async () => {
    await navigate(false);
    await act(() => sidebar.onOpenChange(false));
    expect(sidebar.open).toBe(false);

    await navigate(true);
    expect(committedOpen).toEqual([true]);

    await navigate(false);
    expect(committedOpen).toEqual([false]);
  });

  it("allows manual Settings toggles and keeps them across section navigation", async () => {
    await navigate(true);
    await act(() => sidebar.onOpenChange(false));
    await navigate(true);
    expect(sidebar.open).toBe(false);

    await act(() => sidebar.onOpenChange(true));
    expect(sidebar.open).toBe(true);
    await act(() => sidebar.onOpenChange(false));

    await navigate(false);
    expect(sidebar.open).toBe(true);
    await navigate(true);
    expect(committedOpen).toEqual([true]);
  });

  it.each([true, false])(
    "preserves the %s chat preference after Settings toggles",
    async (open) => {
      await navigate(false);
      await act(() => sidebar.onOpenChange(open));
      await navigate(true);
      await act(() => sidebar.onOpenChange(false));
      await act(() => sidebar.onOpenChange(true));
      await navigate(false);
      expect(sidebar.open).toBe(open);
    },
  );
});
