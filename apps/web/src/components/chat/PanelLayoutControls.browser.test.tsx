import { DirectionProvider } from "@base-ui/react/direction-provider";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import { WorkspaceTitlebarControls } from "./PanelLayoutControls";

it.each(["ltr", "rtl"] as const)(
  "positions panel controls away from the sidebar in %s and after changing direction",
  async (initialDirection) => {
    await page.viewport(1000, 800);
    const layout = (direction: "ltr" | "rtl") => (
      <DirectionProvider direction={direction}>
        <div dir={direction}>
          <WorkspaceTitlebarControls
            showMaximizeControl
            rightPanelOpen
            animationsActive={false}
            maximized={false}
            onToggleMaximized={() => {}}
          >
            <button type="button">Panels</button>
          </WorkspaceTitlebarControls>
        </div>
      </DirectionProvider>
    );
    await using screen = await render(layout(initialDirection));
    for (const direction of [
      initialDirection,
      initialDirection === "rtl" ? "ltr" : "rtl",
    ] as const) {
      await screen.rerender(layout(direction));
      await expect.element(screen.getByRole("button", { name: "Panels" })).toBeVisible();
      await vi.waitFor(() => {
        const controls = screen.container.querySelector<HTMLElement>(
          "[data-workspace-titlebar-controls]",
        )!;
        const bounds = controls.getBoundingClientRect();
        const edgeDistance = direction === "rtl" ? bounds.left : window.innerWidth - bounds.right;
        expect(edgeDistance).toBeGreaterThanOrEqual(10);
        expect(edgeDistance).toBeLessThan(20);
      });
    }
  },
);
