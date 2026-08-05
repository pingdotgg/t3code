import * as React from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import { Schema } from "effect";

import { getLocalStorageItem, setLocalStorageItem } from "../../hooks/useLocalStorage";
import { SidebarProvider, SidebarTrigger } from "./sidebar";

const SIDEBAR_OPEN_STORAGE_KEY = "sidebar_state";

function clearSidebarPersistence() {
  window.localStorage.removeItem(SIDEBAR_OPEN_STORAGE_KEY);
  // Clear only the sidebar cookie without touching unrelated test cookies.
  document.cookie = `${SIDEBAR_OPEN_STORAGE_KEY}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
}

async function mountTrigger(defaultOpen: boolean) {
  // Persistence applies to desktop open state; mobile uses a separate sheet flag.
  await page.viewport(1280, 800);
  return await render(
    <SidebarProvider defaultOpen={defaultOpen}>
      <SidebarTrigger />
    </SidebarProvider>,
  );
}

describe("sidebar open-state persistence", () => {
  beforeEach(() => {
    clearSidebarPersistence();
  });

  afterEach(() => {
    clearSidebarPersistence();
    document.body.innerHTML = "";
  });

  it("uses a stored open value over defaultOpen", async () => {
    setLocalStorageItem(SIDEBAR_OPEN_STORAGE_KEY, false, Schema.Boolean);

    const screen = await mountTrigger(true);
    try {
      const trigger = page.getByRole("button", { name: "Expand sidebar" });
      await expect.element(trigger).toBeInTheDocument();
      await expect.element(trigger).toHaveAttribute("aria-expanded", "false");
      await expect.element(trigger).toHaveAttribute("data-state", "collapsed");
    } finally {
      await screen.unmount();
    }
  });

  it("falls back to defaultOpen when stored value is corrupt", async () => {
    window.localStorage.setItem(SIDEBAR_OPEN_STORAGE_KEY, "{not-json");

    // defaultOpen=true proves we did not treat corrupt storage as a closed value.
    const screen = await mountTrigger(true);
    try {
      const trigger = page.getByRole("button", { name: "Collapse sidebar" });
      await expect.element(trigger).toBeInTheDocument();
      await expect.element(trigger).toHaveAttribute("aria-expanded", "true");
      await expect.element(trigger).toHaveAttribute("data-state", "expanded");
    } finally {
      await screen.unmount();
    }
  });

  it("writes the toggled open value to localStorage", async () => {
    setLocalStorageItem(SIDEBAR_OPEN_STORAGE_KEY, true, Schema.Boolean);

    const screen = await mountTrigger(true);
    try {
      const collapse = page.getByRole("button", { name: "Collapse sidebar" });
      await expect.element(collapse).toBeInTheDocument();
      await collapse.click();

      const expand = page.getByRole("button", { name: "Expand sidebar" });
      await expect.element(expand).toBeInTheDocument();
      await expect.element(expand).toHaveAttribute("aria-expanded", "false");

      expect(getLocalStorageItem(SIDEBAR_OPEN_STORAGE_KEY, Schema.Boolean)).toBe(false);
    } finally {
      await screen.unmount();
    }
  });

  it("does not persist open state for controlled providers", async () => {
    setLocalStorageItem(SIDEBAR_OPEN_STORAGE_KEY, true, Schema.Boolean);
    await page.viewport(1280, 800);

    function ControlledSidebar() {
      const [open, setOpen] = React.useState(true);
      return (
        <SidebarProvider open={open} onOpenChange={setOpen}>
          <SidebarTrigger />
        </SidebarProvider>
      );
    }

    const screen = await render(<ControlledSidebar />);
    try {
      const collapse = page.getByRole("button", { name: "Collapse sidebar" });
      await expect.element(collapse).toBeInTheDocument();
      await collapse.click();

      const expand = page.getByRole("button", { name: "Expand sidebar" });
      await expect.element(expand).toBeInTheDocument();
      await expect.element(expand).toHaveAttribute("aria-expanded", "false");

      // Nested controlled sidebars (diff panel) must not clobber app sidebar state.
      expect(getLocalStorageItem(SIDEBAR_OPEN_STORAGE_KEY, Schema.Boolean)).toBe(true);
    } finally {
      await screen.unmount();
    }
  });
});
