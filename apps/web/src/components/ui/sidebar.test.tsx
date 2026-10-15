import { act } from "react";
import { create } from "react-test-renderer";
import { describe, expect, it, vi } from "vite-plus/test";

import { SidebarProvider, useSidebar } from "./sidebar";
import { THREAD_MAIN_CONTENT_MIN_WIDTH, THREAD_SIDEBAR_MIN_WIDTH } from "../threadSidebarWidth";
import { resolveSidebarState } from "./sidebarState";

vi.mock("~/lib/utils", () => ({ cn: () => "" }));

describe("responsive sidebar state", () => {
  it("uses mobile sheet visibility for the shared responsive state", () => {
    expect(resolveSidebarState({ isMobile: true, open: true, openMobile: false })).toBe(
      "collapsed",
    );
    expect(resolveSidebarState({ isMobile: true, open: false, openMobile: true })).toBe("expanded");
    expect(resolveSidebarState({ isMobile: false, open: true, openMobile: false })).toBe(
      "expanded",
    );
  });
});

it("uses a sheet at scaled half-screen widths and restores inline visibility when widened", async () => {
  let viewportWidth = 768;
  const listeners = new Set<() => void>();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", {
    matchMedia: (query: string) => ({
      get matches() {
        const maximum = /max-width: (\d+)px/.exec(query);
        return maximum !== null && viewportWidth <= Number(maximum[1]);
      },
      addEventListener: (_event: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_event: string, listener: () => void) => listeners.delete(listener),
    }),
  });
  function Controls() {
    const { isMobile, state, toggleSidebar } = useSidebar();
    return <button onClick={toggleSidebar}>{`${isMobile ? "sheet" : "inline"}:${state}`}</button>;
  }
  let renderer: ReturnType<typeof create> | undefined;
  try {
    await act(() => {
      renderer = create(
        <SidebarProvider
          mobileBreakpoint={THREAD_SIDEBAR_MIN_WIDTH + THREAD_MAIN_CONTENT_MIN_WIDTH}
        >
          <Controls />
        </SidebarProvider>,
      );
    });
    const control = () => renderer!.root.findByType("button");
    expect(control().props.children).toBe("sheet:collapsed");
    await act(() => control().props.onClick());
    expect(control().props.children).toBe("sheet:expanded");
    await act(() => control().props.onClick());
    expect(control().props.children).toBe("sheet:collapsed");
    for (const width of [600, 664, 767, 847, 848, 1100, 768]) {
      viewportWidth = width;
      await act(() => {
        for (const listener of listeners) listener();
      });
      expect(control().props.children).toBe(width < 848 ? "sheet:collapsed" : "inline:expanded");
    }
  } finally {
    await act(() => renderer?.unmount());
    vi.unstubAllGlobals();
  }
});
