/// <reference lib="dom" />
import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "Installed fonts are available after granting access without reloading",
  WEB,
  async ({ t3, app, browser, screen }) => {
    await t3.project("demo");
    await browser.addInitScript(() => {
      const permission = Object.assign(new EventTarget(), {
        state: "prompt",
        onchange: null as ((event: Event) => void) | null,
      });
      const query = navigator.permissions.query.bind(navigator.permissions);
      Object.defineProperty(navigator.permissions, "query", {
        value: (descriptor: PermissionDescriptor) =>
          String(descriptor.name) === "local-fonts"
            ? Promise.resolve(permission)
            : query(descriptor),
      });
      Object.defineProperty(window, "queryLocalFonts", {
        value: async () => {
          if (permission.state === "granted") return [{ family: "Scenario Sans" }];
          document.documentElement.dataset.fontPromptDismissed = "";
          throw new DOMException("The local font prompt was dismissed", "NotAllowedError");
        },
      });
      window.addEventListener("grant-scenario-fonts", () => {
        permission.state = "granted";
        const change = new Event("change");
        permission.dispatchEvent(change);
        permission.onchange?.(change);
      });
    });

    await t3.open("/settings/appearance");
    const family = screen.getByRole("textbox", "Interface font family");
    await family.tap();
    await browser.locator("html[data-font-prompt-dismissed]").waitFor({ state: "attached" });
    await family.press("Tab");

    await browser.evaluate(() => {
      window.dispatchEvent(new Event("grant-scenario-fonts"));
      return null;
    });
    await browser.locator('[aria-label="Interface font family"]').tap();

    // A focus that enumerates the fonts can open the picker itself.
    const closedPicker = browser.locator(
      '[data-slot="combobox-trigger"][aria-label="Interface font family"][aria-expanded="false"]',
    );
    if (await closedPicker.isVisible()) await closedPicker.tap();

    await app.screenshot("typography-after-granting-access");
    await expect(screen.getByRole("option", "Scenario Sans")).toBeVisible();

    // Start a fresh page to exercise click retry with no font list cached.
    await app.open("/settings/appearance");
    await family.tap();
    await browser.locator("html[data-font-prompt-dismissed]").waitFor({ state: "attached" });
    await expect(family).toBeFocused();
    await browser.evaluate(() => {
      window.dispatchEvent(new Event("grant-scenario-fonts"));
      return null;
    });
    await family.tap();
    await expect(screen.getByRole("option", "Scenario Sans")).toBeVisible();
  },
);
