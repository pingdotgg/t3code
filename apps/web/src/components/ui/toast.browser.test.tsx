import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { ToastProvider, toastManager } from "./toast";

describe("toastManager", () => {
  it("copies the full error when the description is a short summary", async () => {
    await using _screen = await render(<ToastProvider>{null}</ToastProvider>);
    using writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const message = "Relay encountered an internal error (upstream_unavailable).";
    const id = toastManager.add({
      type: "error",
      title: "Could not update T3 Connect",
      description: "Could not finish disconnecting. Try again.",
      data: { copyErrorText: message },
    });
    using _toast = { [Symbol.dispose]: () => toastManager.close(id) };

    await page.getByRole("button", { name: "Copy error", exact: true }).click();

    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(message));
  });

  it("shows a toast added before any provider mounted", async () => {
    toastManager.add({ type: "info", title: "Raised before the first render" });

    await using _screen = await render(<ToastProvider>{null}</ToastProvider>);

    await expect.element(page.getByText("Raised before the first render")).toBeVisible();
  });
});
