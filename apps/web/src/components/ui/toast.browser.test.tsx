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

    await vi.waitFor(() => {
      const anchoredViewport = document.querySelector('[data-slot="toast-viewport-anchored"]');
      expect(anchoredViewport?.getAttribute("aria-live")).toBe("polite");
      expect(anchoredViewport?.getAttribute("role")).toBeNull();
      expect(page.getByRole("region", { name: "Notifications" }).elements()).toHaveLength(1);
    });
  });
});
