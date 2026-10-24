import { describe, expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { SidebarProvider, SidebarTrigger } from "./sidebar";

const STORAGE_KEY = "sidebar_test_open";

async function setup() {
  await page.viewport(1280, 900);
  localStorage.removeItem(STORAGE_KEY);
}

function Layout() {
  return (
    <SidebarProvider storageKey={STORAGE_KEY}>
      <SidebarTrigger />
    </SidebarProvider>
  );
}

describe("SidebarProvider", () => {
  // regression: #24191 the collapsed state was saved but never restored on launch
  it("restores the saved open state on the next mount", async () => {
    await setup();
    {
      await using screen = await render(<Layout />);
      const trigger = screen.getByRole("button", { name: "Toggle Sidebar" });
      await expect.element(trigger).toHaveAttribute("aria-pressed", "true");
      await userEvent.click(trigger);
      await expect.element(trigger).toHaveAttribute("aria-pressed", "false");
    }

    await using screen = await render(<Layout />);
    await expect
      .element(screen.getByRole("button", { name: "Toggle Sidebar" }))
      .toHaveAttribute("aria-pressed", "false");
  });
});
