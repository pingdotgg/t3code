import { useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { act, fakeTimers, render } from "../../../test/render";
import { SidebarSwipeArea, type SidebarTab } from "./SidebarTabs";

function SwipeHarness() {
  const [tab, setTab] = useState<SidebarTab>("active");
  return (
    <div className="flex h-[200px] w-[300px] flex-col">
      <output>{tab}</output>
      <button type="button" onClick={() => setTab("settled")}>
        Settled
      </button>
      <SidebarSwipeArea
        value={tab}
        onValueChange={setTab}
        workingShelfEnabled
        renderPreview={(preview) => <li>{preview}</li>}
      >
        <ul>
          <li>{tab}</li>
        </ul>
      </SidebarSwipeArea>
    </div>
  );
}

describe("SidebarSwipeArea", () => {
  it("keeps a tab picked while a swipe is still landing", async () => {
    // No router: the harness has no links or routes.
    await using screen = await render(<SwipeHarness />, { router: false });
    using _timers = fakeTimers();
    const area = screen.container.querySelector("[data-sidebar-swipe-panel]")!.parentElement!;

    await act(() => {
      area.dispatchEvent(new WheelEvent("wheel", { deltaX: 200, cancelable: true }));
    });
    const panel = area.querySelector<HTMLElement>("[data-sidebar-swipe-panel]")!;
    expect(panel.style.transform).toBe("translateX(-300px)");
    await act(() => screen.container.querySelector("button")!.click());
    await act(() => vi.advanceTimersByTime(500));

    expect(screen.container.querySelector("output")?.textContent).toBe("settled");
  });
});
