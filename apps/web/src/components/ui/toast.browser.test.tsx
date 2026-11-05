import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { AnchoredToastProvider, ToastProvider, toastManager } from "./toast";

describe("toastManager", () => {
  it("shows a toast added before any provider mounted", async () => {
    toastManager.add({ type: "info", title: "Raised before the first render" });

    await using _screen = await render(<ToastProvider>{null}</ToastProvider>);

    await expect.element(page.getByText("Raised before the first render")).toBeVisible();
  });

  it("exposes one Notifications landmark while anchored toasts stay a live region", async () => {
    await using _screen = await render(
      <ToastProvider>
        <AnchoredToastProvider>{null}</AnchoredToastProvider>
      </ToastProvider>,
    );

    const anchoredViewport = await vi.waitFor(() => {
      const viewport = document.querySelector('[data-slot="toast-viewport-anchored"]');
      expect(viewport).not.toBeNull();
      return viewport!;
    });

    expect(anchoredViewport.getAttribute("aria-live")).toBe("polite");
    expect(page.getByRole("region", { name: "Notifications" }).elements()).toHaveLength(1);
  });
});
