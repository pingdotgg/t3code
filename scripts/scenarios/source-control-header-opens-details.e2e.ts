/// <reference lib="dom" />
import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "The Linear settings header opens its connection details",
  WEB,
  async ({ t3, app, screen, browser }) => {
    await t3.project("demo");
    await t3.open("/settings/source-control");
    await screen.getByText("GitHub", { exact: true }).waitFor();
    await screen.getByText("Linear", { exact: true }).waitFor();
    // Click the label's position on both versions, including when a header trigger overlays it.
    const point = await browser.evaluate(() => {
      const label = [...document.querySelectorAll("span")].find(
        (element) => element.textContent === "Linear",
      )!;
      label.scrollIntoView({ block: "center" });
      const box = label.getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    });
    await browser.mouse.move(point.x, point.y);
    await browser.mouse.down();
    await browser.mouse.up();
    try {
      await expect(screen.getByText("Personal API key", { exact: true })).toBeVisible();
    } finally {
      await browser.evaluate(async () => {
        await Promise.all(
          document
            .getAnimations()
            .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
            .map((animation) => animation.finished.catch(() => null)),
        );
        return null;
      });
      await app.screenshot("linear-header-clicked");
    }
  },
);
