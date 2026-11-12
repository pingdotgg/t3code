import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "Plain content search keeps filename-like text literal",
  WEB,
  async ({ t3, app, screen, browser }) => {
    await t3.project("literal-search", {
      "words.txt": "needle *.ts\n",
      "code.ts": "needle\n",
    });
    await t3.open();

    await screen.getByTestId("composer-editor").tap();
    await browser.keyboard.press("Control+Shift+f");
    await screen.getByPlaceholder("Search in literal-search").fill("needle *.ts");
    await screen.getByText("1 results in 1 files", { exact: true }).waitFor({ state: "visible" });
    await app.screenshot("literal-search-results");
    await expect(screen.getByText("words.txt", { exact: true })).toBeVisible();
    await expect(screen.getByText("code.ts", { exact: true })).toBeHidden();
  },
);
