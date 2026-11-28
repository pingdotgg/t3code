import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "Sending a new thread's first message leaves the sidebar where it was",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await t3.project("demo");
    for (let index = 1; index <= 12; index += 1) {
      await t3.thread({ project, title: `Earlier work ${index}`, messages: ["first"] });
    }
    // Short enough that the Working shelf, below the listed threads, starts out of view.
    await browser.setViewport({ width: 1280, height: 520 });
    await t3.open();
    await expect(screen.getByRole("button", "Earlier work 12", { exact: false })).toBeVisible();
    const sidebarScrollTop = () =>
      browser.evaluate(
        () =>
          document.querySelector("[data-sidebar-row]")?.closest("[data-slot=scroll-area-viewport]")
            ?.scrollTop ?? -1,
      );
    expect(await sidebarScrollTop()).toBe(0);

    await screen.getByRole("textbox").fill("Give me a short tour");
    await screen.getByRole("textbox").press("Enter");
    await expect(screen.getByRole("button", "Stop generation")).toBeVisible();
    // The new thread's row mounts in the Working shelf, below the fold.
    await expect(
      screen.getByRole("button", "Give me a short tour, Working", { exact: false }),
    ).toBeAttached();
    await app.screenshot("after-first-send");

    expect(await sidebarScrollTop()).toBe(0);
  },
);
