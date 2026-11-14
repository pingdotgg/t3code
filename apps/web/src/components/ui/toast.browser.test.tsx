import { describe, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { ToastProvider, toastManager } from "./toast";

describe("toastManager", () => {
  it("shows a toast added before any provider mounted", async () => {
    toastManager.add({ type: "info", title: "Raised before the first render" });

    await using _screen = await render(<ToastProvider>{null}</ToastProvider>);

    await expect.element(page.getByText("Raised before the first render")).toBeVisible();
  });
});
