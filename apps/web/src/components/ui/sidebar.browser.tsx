import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { Sidebar, SidebarProvider, SidebarRail } from "./sidebar";

vi.mock("~/hooks/useMediaQuery", () => ({
  useIsMobile: () => false,
}));

const SIDEBAR_STORAGE_KEY = "sidebar-browser-test-width";
const DEFAULT_WIDTH_PX = 360;
const MIN_WIDTH_PX = 300;

function TestSidebar(props: {
  maxAcceptedWidthRef: { current: number };
  shouldAcceptWidthSpy: (nextWidth: number) => void;
}) {
  return (
    <div style={{ minHeight: "640px", minWidth: "1280px" }}>
      <SidebarProvider
        defaultOpen
        open
        style={{ "--sidebar-width": `${DEFAULT_WIDTH_PX}px` } as React.CSSProperties}
      >
        <main className="min-w-0 flex-1" />
        <Sidebar
          side="right"
          collapsible="offcanvas"
          resizable={{
            minWidth: MIN_WIDTH_PX,
            shouldAcceptWidth: ({ nextWidth }) => {
              props.shouldAcceptWidthSpy(nextWidth);
              return nextWidth <= props.maxAcceptedWidthRef.current;
            },
            storageKey: SIDEBAR_STORAGE_KEY,
          }}
        >
          <div>Sidebar content</div>
          <SidebarRail />
        </Sidebar>
      </SidebarProvider>
    </div>
  );
}

function getSidebarWrapper(): HTMLElement {
  const wrapper = document.querySelector<HTMLElement>("[data-slot='sidebar-wrapper']");
  if (!wrapper) {
    throw new Error("Expected sidebar wrapper to be mounted.");
  }
  return wrapper;
}

function getSidebarWidth(): number {
  return Number.parseFloat(getSidebarWrapper().style.getPropertyValue("--sidebar-width"));
}

async function mountTestSidebar(props: {
  maxAcceptedWidthRef: { current: number };
  shouldAcceptWidthSpy: (nextWidth: number) => void;
}) {
  const host = document.createElement("div");
  document.body.append(host);
  const screen = await render(<TestSidebar {...props} />, { container: host });

  return {
    cleanup: async () => {
      await screen.unmount();
      host.remove();
    },
  };
}

describe("Sidebar persisted width validation", () => {
  afterEach(() => {
    window.localStorage.clear();
    document.body.innerHTML = "";
  });

  it("revalidates a stored width before restoring it", async () => {
    window.localStorage.setItem(SIDEBAR_STORAGE_KEY, "640");
    const maxAcceptedWidthRef = { current: 500 };
    const shouldAcceptWidthSpy = vi.fn();

    const mounted = await mountTestSidebar({
      maxAcceptedWidthRef,
      shouldAcceptWidthSpy,
    });

    try {
      await vi.waitFor(() => {
        expect(getSidebarWidth()).toBeLessThanOrEqual(maxAcceptedWidthRef.current);
      });
      expect(shouldAcceptWidthSpy).toHaveBeenCalled();
    } finally {
      await mounted.cleanup();
    }
  });

  it("revalidates the current width when the window size changes", async () => {
    window.localStorage.setItem(SIDEBAR_STORAGE_KEY, "560");
    const maxAcceptedWidthRef = { current: 560 };
    const shouldAcceptWidthSpy = vi.fn();

    const mounted = await mountTestSidebar({
      maxAcceptedWidthRef,
      shouldAcceptWidthSpy,
    });

    try {
      await vi.waitFor(() => {
        expect(getSidebarWidth()).toBe(560);
      });

      const initialCallCount = shouldAcceptWidthSpy.mock.calls.length;
      maxAcceptedWidthRef.current = 420;
      window.dispatchEvent(new Event("resize"));

      await vi.waitFor(() => {
        expect(getSidebarWidth()).toBeLessThanOrEqual(maxAcceptedWidthRef.current);
      });
      expect(shouldAcceptWidthSpy.mock.calls.length).toBeGreaterThan(initialCallCount);
    } finally {
      await mounted.cleanup();
    }
  });
});
