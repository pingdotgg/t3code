import "../../index.css";

import { useEffect } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { Sidebar, SidebarProvider } from "./sidebar";

function WindowShortcut({ onShortcut }: { onShortcut: () => void }) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey && event.key === "2") onShortcut();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onShortcut]);
  return null;
}

// regression: #21789
describe("narrow-window sidebar", () => {
  it("runs sidebar shortcuts while the drawer is closed", async () => {
    await page.viewport(640, 900);
    expect(window.matchMedia("(max-width: 767px)").matches).toBe(true);
    const onShortcut = vi.fn();
    await using _screen = await render(
      <SidebarProvider>
        <Sidebar>
          <WindowShortcut onShortcut={onShortcut} />
        </Sidebar>
      </SidebarProvider>,
    );

    await userEvent.keyboard("{Meta>}2{/Meta}");

    expect(onShortcut).toHaveBeenCalledOnce();
    const drawer = document.querySelector<HTMLElement>('[data-slot="sidebar"][data-mobile="true"]');
    expect(drawer?.checkVisibility() ?? false).toBe(false);
  });
});
