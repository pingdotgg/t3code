import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "Whole-word content search finds a match after 100 rejected lines",
  WEB,
  async ({ t3, app, screen, browser }) => {
    await t3.open();
    await screen.getByRole("button", "Start", { exact: true }).tap({ timeout: 120_000 });
    const project = await t3.project("whole-word-proof", {
      "words.txt": "needleSuffix\n".repeat(100) + "needle\n",
    });
    await t3.thread({ project, title: "Whole-word fixture", messages: ["go"] });
    await t3.open();
    await screen.getByRole("button", "Whole-word fixture", { exact: false }).tap();
    await browser.keyboard.press("Control+Shift+f");
    await screen.getByRole("button", "Match whole word", { exact: true }).tap();
    await screen.getByRole("combobox", "Search in whole-word-proof").fill("needle");
    await expect(screen.getByText("results in", { exact: false })).toBeVisible();
    await app.screenshot("whole-word-result");
    await expect(screen.getByText("1 results in 1 files", { exact: true })).toBeVisible();
    await expect(screen.getByRole("button", "101 needle", { exact: true })).toBeVisible();
    await screen.getByRole("button", "Match case", { exact: true }).tap();
    await screen.getByRole("combobox", "Search in whole-word-proof").fill("NEEDLE");
    await expect(screen.getByText("0 results in 0 files", { exact: true })).toBeVisible();
    await screen.getByRole("combobox", "Search in whole-word-proof").fill("needle");
    await expect(screen.getByRole("button", "101 needle", { exact: true })).toBeVisible();
    await app.screenshot("whole-word-match-case");
  },
);
