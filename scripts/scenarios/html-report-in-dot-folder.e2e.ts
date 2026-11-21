import { expect } from "e2e";

import { test, WEB } from "./lathe.ts";

test(
  "An explicitly opened HTML report in a dot-prefixed folder renders its contents",
  WEB,
  async ({ lathe, app, screen, browser }) => {
    const project = await lathe.project("demo", {
      ".reports/report.html": "<!doctype html><html><body><h1>Quarterly report</h1></body></html>",
    });
    const thread = await lathe.thread({ project, title: "Review report", messages: ["Start"] });
    await lathe.open(thread);
    await expect(screen.getByText("fixture turn complete", { exact: false })).toBeVisible();

    await browser.keyboard.press("Control+p");
    await screen.getByPlaceholder("Search files…").fill("report.html");
    await screen.getByRole("option", "report.html", { exact: false }).tap();

    const document = browser.frameLocator('iframe[title=".reports/report.html"]');
    try {
      await expect(document.locator("body")).toContainText("Quarterly report");
    } finally {
      await app.screenshot("report-preview");
    }
  },
);
